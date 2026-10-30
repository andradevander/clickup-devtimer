import { randomUUID } from 'node:crypto';
import { validateQueue } from '../core/validation';
import type { QueueFile, QueueItem } from '../types/session';
import { Emitter, type Disposable } from '../util/emitter';
import { SerialQueue } from '../util/serialQueue';
import { ClickUpApiError, isAdvancedTimeTrackingLimitMessage, type ClickUpService } from './clickupService';
import type { Clock } from './rateLimiter';
import { JsonFileStore } from './storageService';

export type SyncClient = Pick<ClickUpService, 'createTimeEntry' | 'getTimeEntries'>;

export type NewQueueItem = Pick<
  QueueItem,
  'sessionId' | 'teamId' | 'taskId' | 'taskName' | 'start' | 'duration' | 'description'
>;

export interface ProcessResult {
  synced: number;
  /** Items that failed permanently in this run. */
  failed: number;
  /** Items still waiting (pending or failed) after this run. */
  remaining: number;
  /** Processing stopped because the token is missing or invalid. */
  authError: boolean;
  /**
   * Entries synced without their description because the ClickUp plan ran out of "Advanced Time
   * Tracking" uses.
   */
  descriptionsDropped: number;
  /**
   * A time tracking limit of the ClickUp plan was reached in this run, or entries were skipped
   * because it was reached earlier. The workspace's entries are skipped until
   * {@link SyncQueue.retry} or {@link SyncQueue.retryAll}.
   */
  planLimitReached: boolean;
  /**
   * Workspaces found in this run to reject descriptions (not counting those passed in
   * {@link SyncQueueOptions.noDescriptionTeams}); worth persisting.
   */
  learnedNoDescriptionTeams: string[];
}

export interface SyncQueueOptions {
  directory: string;
  client: SyncClient;
  clock?: Clock;
  newId?: () => string;
  /** Workspaces already known to reject descriptions; their entries are sent without one. */
  noDescriptionTeams?: Iterable<string>;
}

const MINUTE_MS = 60_000;
const MAX_BACKOFF_MS = 60 * MINUTE_MS;
/** How long an item stays reserved by the window sending it. */
export const LEASE_MS = 2 * MINUTE_MS;
/** Margin when searching ClickUp for an entry that may already exist. */
const DUPLICATE_SEARCH_MARGIN_MS = 1_000;

/** 1, 2, 4, 8... minutes, capped at 60. */
export function backoffMs(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, MINUTE_MS * 2 ** Math.max(0, attempts - 1));
}

const EMPTY_QUEUE: QueueFile = { schemaVersion: 1, items: [] };

type Outcome =
  | { kind: 'synced'; descriptionDropped: boolean }
  | { kind: 'retry'; patch: Partial<QueueItem>; stopRun: boolean }
  | { kind: 'failed'; patch: Partial<QueueItem>; planLimit: boolean }
  | { kind: 'authError' };

const hasDescription = (item: QueueItem): boolean => item.description.trim() !== '';

/** Failed only because the plan ran out of description uses: sendable again without it. */
const failedOnAdvancedLimit = (item: QueueItem): boolean =>
  item.status === 'failed' &&
  hasDescription(item) &&
  item.lastError !== null &&
  isAdvancedTimeTrackingLimitMessage(item.lastError.message);

/**
 * Offline-first queue of time entries (spec §2.2-F). Every entry goes through the queue, so time is
 * never lost when ClickUp is unreachable. Only the owner window should call {@link process}.
 */
export class SyncQueue implements Disposable {
  private readonly store: JsonFileStore<QueueFile>;
  private readonly client: SyncClient;
  private readonly clock: Clock;
  private readonly newId: () => string;
  private readonly serial = new SerialQueue();
  private processing: Promise<ProcessResult> | undefined;
  /** Workspaces whose plan rejects descriptions ("Advanced Time Tracking" limit reached). */
  private readonly noDescriptionTeams: Set<string>;
  /** Workspaces whose plan reached its time tracking limit; skipped until the user retries. */
  private readonly planLimitedTeams = new Set<string>();
  private revivedAdvancedLimitFailures = false;
  /** The item the user asked to retry; sent first in the next run. */
  private priorityId: string | undefined;
  private readonly changeEmitter = new Emitter<void>();

  /** Fires after the queue file changes through this instance. */
  readonly onDidChange = this.changeEmitter.event;

  constructor(options: SyncQueueOptions) {
    this.store = new JsonFileStore(options.directory, 'queue.json', { validate: validateQueue });
    this.client = options.client;
    this.clock = options.clock ?? Date.now;
    this.newId = options.newId ?? randomUUID;
    this.noDescriptionTeams = new Set(options.noDescriptionTeams);
  }

  async items(): Promise<QueueItem[]> {
    return (await this.store.read())?.items ?? [];
  }

  async hasSession(sessionId: string): Promise<boolean> {
    return (await this.items()).some((item) => item.sessionId === sessionId);
  }

  async enqueue(entries: readonly NewQueueItem[]): Promise<QueueItem[]> {
    const now = this.clock();
    const added = entries.map((entry): QueueItem => ({
      ...entry,
      id: this.newId(),
      status: 'pending',
      attempts: 0,
      nextAttemptAt: now,
      outcomeUnknown: false,
      leaseUntil: 0,
      lastError: null,
      createdAt: now,
    }));
    await this.mutate((items) => [...items, ...added]);
    return added;
  }

  /** Makes a failed or backed-off item due right away. */
  async retry(id: string): Promise<void> {
    const item = (await this.items()).find((current) => current.id === id);
    if (item) {
      this.planLimitedTeams.delete(item.teamId);
    }
    this.priorityId = id;
    await this.mutate((items) =>
      items.map((item) =>
        item.id === id ? { ...item, status: 'pending', nextAttemptAt: 0, leaseUntil: 0 } : item,
      ),
    );
  }

  /** Makes every item due right away (e.g. after the token was fixed). */
  async retryAll(): Promise<void> {
    this.planLimitedTeams.clear();
    await this.mutate((items) =>
      items.map((item) => ({ ...item, status: 'pending', nextAttemptAt: 0, leaseUntil: 0 })),
    );
  }

  /** Forgets which workspaces reject descriptions, so they are tried again (e.g. after a plan upgrade). */
  resetNoDescriptionTeams(): void {
    this.noDescriptionTeams.clear();
  }

  async discard(id: string): Promise<void> {
    await this.mutate((items) => items.filter((item) => item.id !== id));
  }

  /**
   * Sends every due item, one at a time. Concurrent calls share the same run. Stops early when the
   * token is invalid, the rate limit is hit or the network is down, since the next items would fail
   * the same way.
   */
  process(): Promise<ProcessResult> {
    this.processing ??= this.runProcess().finally(() => {
      this.processing = undefined;
    });
    return this.processing;
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }

  private async runProcess(): Promise<ProcessResult> {
    let synced = 0;
    let failed = 0;
    let authError = false;
    let descriptionsDropped = 0;
    let planLimitReached = false;
    const knownNoDescriptionTeams = new Set(this.noDescriptionTeams);

    await this.reviveAdvancedLimitFailures();
    const due = (await this.items()).filter((item) => this.isDue(item, this.clock()));
    const priority = due.findIndex((item) => item.id === this.priorityId);
    this.priorityId = undefined;
    if (priority > 0) {
      due.unshift(...due.splice(priority, 1));
    }

    for (const item of due) {
      if (this.planLimitedTeams.has(item.teamId)) {
        // Still waiting for the plan limit to be lifted.
        planLimitReached = true;
        continue;
      }
      if (!(await this.claimLease(item.id))) {
        // Another window is sending it, or it is gone already.
        continue;
      }
      const outcome = await this.send(item);
      if (outcome.kind === 'synced') {
        synced++;
        if (outcome.descriptionDropped) {
          descriptionsDropped++;
        }
        await this.mutate((items) => items.filter((current) => current.id !== item.id));
        continue;
      }
      if (outcome.kind === 'failed') {
        failed++;
      }
      const patch = outcome.kind === 'authError' ? {} : outcome.patch;
      await this.mutate((items) =>
        items.map((current) => (current.id === item.id ? { ...current, ...patch, leaseUntil: 0 } : current)),
      );
      if (outcome.kind === 'authError') {
        authError = true;
        break;
      }
      if (outcome.kind === 'retry' && outcome.stopRun) {
        break;
      }
      if (outcome.kind === 'failed' && outcome.planLimit) {
        // The workspace's next entries would hit the same limit: skip them (other workspaces go on).
        this.planLimitedTeams.add(item.teamId);
        planLimitReached = true;
      }
    }

    return {
      synced,
      failed,
      remaining: (await this.items()).length,
      authError,
      descriptionsDropped,
      planLimitReached,
      learnedNoDescriptionTeams: [...this.noDescriptionTeams].filter(
        (team) => !knownNoDescriptionTeams.has(team),
      ),
    };
  }

  /**
   * Once per instance: makes entries that failed because the plan ran out of description uses
   * pending again, since they are now sent without the description.
   */
  private async reviveAdvancedLimitFailures(): Promise<void> {
    if (this.revivedAdvancedLimitFailures) {
      return;
    }
    this.revivedAdvancedLimitFailures = true;
    if (!(await this.items()).some(failedOnAdvancedLimit)) {
      return;
    }
    await this.mutate((items) =>
      items.map((item) =>
        failedOnAdvancedLimit(item) ? { ...item, status: 'pending', nextAttemptAt: 0, leaseUntil: 0 } : item,
      ),
    );
  }

  private isDue(item: QueueItem, now: number): boolean {
    return item.status === 'pending' && item.nextAttemptAt <= now && item.leaseUntil <= now;
  }

  /** Reserves the item for this window; false when it is no longer due (e.g. taken by another window). */
  private async claimLease(id: string): Promise<boolean> {
    let claimed = false;
    await this.mutate((items) => {
      const now = this.clock();
      return items.map((item) => {
        if (item.id !== id || !this.isDue(item, now)) {
          return item;
        }
        claimed = true;
        return { ...item, leaseUntil: now + LEASE_MS };
      });
    });
    return claimed;
  }

  private async send(item: QueueItem): Promise<Outcome> {
    const droppable = hasDescription(item);
    let withDescription = droppable && !this.noDescriptionTeams.has(item.teamId);
    try {
      if (item.outcomeUnknown && (await this.alreadyExists(item))) {
        return { kind: 'synced', descriptionDropped: false };
      }
      try {
        await this.create(item, withDescription);
      } catch (error) {
        if (!withDescription || !(error instanceof ClickUpApiError) || !error.isAdvancedTimeTrackingLimit) {
          throw error;
        }
        // The plan has no "Advanced Time Tracking" uses left: the description is what costs one.
        this.noDescriptionTeams.add(item.teamId);
        withDescription = false;
        await this.create(item, false);
      }
      return { kind: 'synced', descriptionDropped: droppable && !withDescription };
    } catch (error) {
      return this.outcomeFor(item, error);
    }
  }

  private async create(item: QueueItem, withDescription: boolean): Promise<void> {
    await this.client.createTimeEntry(item.teamId, {
      tid: item.taskId,
      start: item.start,
      duration: item.duration,
      ...(withDescription ? { description: item.description } : {}),
    });
  }

  /** Whether a previous attempt with an unknown outcome actually created the entry. */
  private async alreadyExists(item: QueueItem): Promise<boolean> {
    const entries = await this.client.getTimeEntries(item.teamId, {
      taskId: item.taskId,
      startDate: item.start - DUPLICATE_SEARCH_MARGIN_MS,
      endDate: item.start + item.duration + DUPLICATE_SEARCH_MARGIN_MS,
    });
    return entries.some(
      (entry) => Number(entry.start) === item.start && Number(entry.duration) === item.duration,
    );
  }

  private outcomeFor(item: QueueItem, error: unknown): Outcome {
    const apiError =
      error instanceof ClickUpApiError
        ? error
        : new ClickUpApiError('network', error instanceof Error ? error.message : String(error));
    const lastError = { kind: apiError.kind, message: apiError.message };

    if (apiError.kind === 'noToken' || apiError.kind === 'unauthorized') {
      return { kind: 'authError' };
    }

    if (apiError.kind === 'rateLimited') {
      // Not the entry's fault: no attempt is counted.
      const nextAttemptAt = this.clock() + (apiError.retryAfterMs ?? MINUTE_MS);
      return { kind: 'retry', patch: { nextAttemptAt, lastError }, stopRun: true };
    }

    if (apiError.isTransient) {
      const attempts = item.attempts + 1;
      return {
        kind: 'retry',
        patch: {
          attempts,
          nextAttemptAt: this.clock() + backoffMs(attempts),
          outcomeUnknown: item.outcomeUnknown || apiError.isOutcomeUnknown,
          lastError,
        },
        // Offline: the other entries would fail the same way.
        stopRun: apiError.kind === 'network',
      };
    }

    return {
      kind: 'failed',
      patch: { status: 'failed', attempts: item.attempts + 1, lastError },
      planLimit: apiError.isPlanLimit,
    };
  }

  private async mutate(transform: (items: QueueItem[]) => QueueItem[]): Promise<void> {
    await this.serial.run(() =>
      this.store.update((current) => ({
        schemaVersion: 1,
        items: transform((current ?? EMPTY_QUEUE).items),
      })),
    );
    this.changeEmitter.fire();
  }
}
