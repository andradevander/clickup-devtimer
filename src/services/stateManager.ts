import { randomUUID } from 'node:crypto';
import { isIdle } from '../core/idlePolicy';
import { prepareEntries, type EntryPolicy, type PreparedEntries } from '../core/rounding';
import {
  finalSegments,
  markPersisted,
  normalizeClock,
  pauseSession,
  recordActivity,
  recoverSession,
  resumeSession,
  startSession,
} from '../core/stateMachine';
import { segmentDuration } from '../core/timeMath';
import { validatePersistedState } from '../core/validation';
import type { PersistedState, Session, TaskRef } from '../types/session';
import { Emitter, type Disposable } from '../util/emitter';
import { SerialQueue } from '../util/serialQueue';
import type { Clock } from './rateLimiter';
import { JsonFileStore } from './storageService';
import type { SyncQueue } from './syncQueue';

export type SessionQueue = Pick<SyncQueue, 'enqueue' | 'hasSession'>;

export interface StateManagerOptions {
  directory: string;
  queue: SessionQueue;
  clock?: Clock;
  newId?: () => string;
}

/** Background events the UI reports to the user. */
export type TickEvent = { kind: 'idlePaused' } | { kind: 'idleResumed'; awayMs: number };

export type RecoveryResult =
  /** No session on disk. */
  | { kind: 'none' }
  /** The session had already been queued before the crash; it was cleared. */
  | { kind: 'alreadyQueued' }
  /** The session was running when the editor stopped; it is now paused for the user to decide. */
  | { kind: 'recovered'; session: Session }
  /** The session was already paused; nothing changed. */
  | { kind: 'paused'; session: Session };

export class SessionActiveError extends Error {
  override readonly name = 'SessionActiveError';
}

/** How many recent tasks are kept (the picker shows `recentTasksCount` of them). */
export const MAX_RECENT_TASKS = 20;

const EMPTY_STATE: PersistedState = { schemaVersion: 1, session: null, recentTasks: [], ignoredBranches: [] };

/**
 * Owns the timer session (spec §2.2-C). The file on disk is the source of truth: every change is a
 * read-modify-write of `state.json`, so any window can act on the shared session. The in-memory copy
 * is only a cache for rendering, refreshed with {@link refresh}.
 */
export class StateManager implements Disposable {
  private readonly store: JsonFileStore<PersistedState>;
  private readonly queue: SessionQueue;
  private readonly clock: Clock;
  private readonly newId: () => string;
  private readonly serial = new SerialQueue();
  private cached: PersistedState = EMPTY_STATE;
  private cachedJson = JSON.stringify(EMPTY_STATE);
  private readonly changeEmitter = new Emitter<PersistedState>();

  /** Fires when the state differs from the previous cached state. */
  readonly onDidChange = this.changeEmitter.event;

  constructor(options: StateManagerOptions) {
    this.store = new JsonFileStore(options.directory, 'state.json', { validate: validatePersistedState });
    this.queue = options.queue;
    this.clock = options.clock ?? Date.now;
    this.newId = options.newId ?? randomUUID;
  }

  get state(): PersistedState {
    return this.cached;
  }

  get session(): Session | null {
    return this.cached.session;
  }

  /** Reloads the state written by any window. */
  async refresh(): Promise<PersistedState> {
    return this.serial.run(async () => {
      this.setCache((await this.store.read()) ?? EMPTY_STATE);
      return this.cached;
    });
  }

  async start(task: TaskRef): Promise<Session> {
    return this.mutate((state) => {
      if (state.session !== null) {
        throw new SessionActiveError(`A session is already active on task ${state.session.task.id}`);
      }
      const session = startSession(task, this.clock(), this.newId());
      return {
        state: { ...state, session, recentTasks: withRecent(state.recentTasks, task) },
        result: session,
      };
    });
  }

  async pause(): Promise<void> {
    await this.mutateSession((session) => pauseSession(session, this.clock(), 'manual'));
  }

  async resume(): Promise<void> {
    await this.mutateSession((session) => resumeSession(session, this.clock()));
  }

  async discard(): Promise<void> {
    await this.mutate((state) => ({ state: { ...state, session: null }, result: undefined }));
  }

  /**
   * Ends the session: prepares the time entries (spec §3.7) and queues them for sync. Returns
   * `undefined` when there was no session.
   */
  async finish(description: string, policy: EntryPolicy): Promise<PreparedEntries | undefined> {
    return this.mutateAsync(async (state) => {
      if (state.session === null) {
        return { state, result: undefined };
      }
      const prepared = await this.queueSession(state.session, description, policy);
      return { state: { ...state, session: null }, result: prepared };
    });
  }

  /** Finishes the current session (if any) and starts tracking another task. */
  async switchTask(
    task: TaskRef,
    description: string,
    policy: EntryPolicy,
  ): Promise<{ finished: PreparedEntries | undefined; session: Session }> {
    return this.mutateAsync(async (state) => {
      const finished =
        state.session === null ? undefined : await this.queueSession(state.session, description, policy);
      const session = startSession(task, this.clock(), this.newId());
      return {
        state: { ...state, session, recentTasks: withRecent(state.recentTasks, task) },
        result: { finished, session },
      };
    });
  }

  /**
   * Background work of the owner window: pauses on inactivity (discounting idle time) and resumes
   * automatically when activity comes back after an idle pause (spec §3.5).
   */
  async tick(
    latestActivity: number | undefined,
    inactivityThresholdMs: number,
  ): Promise<TickEvent | undefined> {
    return this.mutate<TickEvent | undefined>((state) => {
      const now = this.clock();
      let session = state.session;
      if (session === null || latestActivity === undefined) {
        return { state, result: undefined };
      }
      session = recordActivity(session, Math.min(latestActivity, now));

      if (session.status === 'running' && isIdle(now, session.lastActivityTime, inactivityThresholdMs)) {
        return {
          state: { ...state, session: pauseSession(session, now, 'idle') },
          result: { kind: 'idlePaused' },
        };
      }

      const pausedAt = session.pausedAt;
      if (
        session.status === 'pausedIdle' &&
        pausedAt !== null &&
        session.lastActivityTime > pausedAt &&
        !isIdle(now, session.lastActivityTime, inactivityThresholdMs)
      ) {
        const resumeAt = session.lastActivityTime;
        return {
          state: { ...state, session: resumeSession(session, resumeAt) },
          result: { kind: 'idleResumed', awayMs: resumeAt - pausedAt },
        };
      }

      return { state, result: undefined };
    });
  }

  /** Periodic save (spec §2.2-C): records the latest activity and the save time, fixing clock jumps. */
  async autosave(latestActivity: number | undefined): Promise<void> {
    await this.mutateSession((session) => {
      const now = this.clock();
      let next = normalizeClock(session, now);
      if (latestActivity !== undefined) {
        next = recordActivity(next, Math.min(latestActivity, now));
      }
      return markPersisted(next, now);
    });
  }

  /**
   * Called on activation when no other live window owns the session: closes a segment left open by
   * a crash or by closing every window, so the user can decide what to do with it (spec §6.1).
   */
  async recover(): Promise<RecoveryResult> {
    return this.mutateAsync<RecoveryResult>(async (state) => {
      const session = state.session;
      if (session === null) {
        return { state, result: { kind: 'none' } };
      }
      if (await this.queue.hasSession(session.id)) {
        return { state: { ...state, session: null }, result: { kind: 'alreadyQueued' } };
      }
      if (session.openSegmentStart === null) {
        return { state, result: { kind: 'paused', session } };
      }
      const recovered = recoverSession(session);
      return { state: { ...state, session: recovered }, result: { kind: 'recovered', session: recovered } };
    });
  }

  async ignoreBranch(branch: string): Promise<void> {
    await this.mutate((state) => ({
      state: state.ignoredBranches.includes(branch)
        ? state
        : { ...state, ignoredBranches: [...state.ignoredBranches, branch] },
      result: undefined,
    }));
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }

  private async queueSession(
    session: Session,
    description: string,
    policy: EntryPolicy,
  ): Promise<PreparedEntries> {
    const prepared = prepareEntries(finalSegments(session, this.clock()), policy);
    if (prepared.kind === 'entries') {
      await this.queue.enqueue(
        prepared.segments.map((segment) => ({
          sessionId: session.id,
          teamId: session.task.teamId,
          taskId: session.task.id,
          taskName: session.task.name,
          start: segment.start,
          duration: segmentDuration(segment),
          description,
        })),
      );
    }
    return prepared;
  }

  private mutateSession(transform: (session: Session) => Session): Promise<void> {
    return this.mutate((state) => {
      const next = state.session === null ? null : transform(state.session);
      return { state: next === state.session ? state : { ...state, session: next }, result: undefined };
    });
  }

  private mutate<T>(transform: (state: PersistedState) => { state: PersistedState; result: T }): Promise<T> {
    return this.mutateAsync((state) => Promise.resolve(transform(state)));
  }

  /** Read-modify-write of `state.json`, serialized within this window. Writes only when something changed. */
  private mutateAsync<T>(
    transform: (state: PersistedState) => Promise<{ state: PersistedState; result: T }>,
  ): Promise<T> {
    return this.serial.run(async () => {
      const current = (await this.store.read()) ?? EMPTY_STATE;
      const { state, result } = await transform(current);
      if (state !== current) {
        await this.store.write(state);
      }
      this.setCache(state);
      return result;
    });
  }

  private setCache(state: PersistedState): void {
    const json = JSON.stringify(state);
    if (json !== this.cachedJson) {
      this.cached = state;
      this.cachedJson = json;
      this.changeEmitter.fire(state);
    }
  }
}

function withRecent(recent: readonly TaskRef[], task: TaskRef): TaskRef[] {
  return [task, ...recent.filter((item) => item.id !== task.id)].slice(0, MAX_RECENT_TASKS);
}
