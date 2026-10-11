import { randomUUID } from 'node:crypto';
import { validateActivity, validateLock } from '../core/validation';
import type { ActivityFile, LockInfo } from '../types/session';
import { Emitter, type Disposable } from '../util/emitter';
import { SerialQueue } from '../util/serialQueue';
import type { Clock, Sleep } from './rateLimiter';
import { JsonFileStore } from './storageService';

export interface WindowCoordinatorOptions {
  directory: string;
  windowId?: string;
  pid?: number;
  clock?: Clock;
  sleep?: Sleep;
  /** How often the owner renews its heartbeat and other windows check the lock. */
  heartbeatIntervalMs?: number;
  /** A lock whose heartbeat is older than this is considered abandoned. */
  staleAfterMs?: number;
  /** Pause between writing the lock and reading it back, to settle races between windows. */
  verifyDelayMs?: number;
  /** Minimum interval between activity writes from this window. */
  activityThrottleMs?: number;
  /** Activity entries older than this are pruned (windows that closed without cleaning up). */
  activityRetentionMs?: number;
  /** Whether a process is still running; lets a crashed owner's lock be taken over right away. */
  isProcessAlive?: (pid: number) => boolean;
  /** Receives errors from the background heartbeat loop (e.g. to log them). */
  onError?: (error: unknown) => void;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Coordinates every window of every VS Code-based editor sharing the storage directory (spec §2.2-E).
 *
 * - **Ownership:** one window holds `lock.json` and runs the background work (idle detection,
 *   warnings, sync queue). Any window may still change the session directly.
 * - **Activity:** every window reports its last activity to `activity.json`; the owner uses the most
 *   recent one, so working in any window keeps the timer running.
 */
export class WindowCoordinator implements Disposable {
  readonly windowId: string;

  private readonly lockStore: JsonFileStore<LockInfo>;
  private readonly activityStore: JsonFileStore<ActivityFile>;
  private readonly pid: number;
  private readonly clock: Clock;
  private readonly sleep: Sleep;
  private readonly heartbeatIntervalMs: number;
  private readonly staleAfterMs: number;
  private readonly verifyDelayMs: number;
  private readonly activityThrottleMs: number;
  private readonly activityRetentionMs: number;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly onError: (error: unknown) => void;
  private readonly activityWrites = new SerialQueue();

  private owner = false;
  private lastActivityWrite = Number.NEGATIVE_INFINITY;
  private pendingActivity: number | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlightTick: Promise<void> | undefined;
  private readonly ownershipEmitter = new Emitter<boolean>();

  /** Fires with the new value whenever this window gains or loses ownership. */
  readonly onDidChangeOwnership = this.ownershipEmitter.event;

  constructor(options: WindowCoordinatorOptions) {
    this.windowId = options.windowId ?? randomUUID();
    this.pid = options.pid ?? process.pid;
    this.clock = options.clock ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000;
    this.staleAfterMs = options.staleAfterMs ?? 30_000;
    this.verifyDelayMs = options.verifyDelayMs ?? 150;
    this.activityThrottleMs = options.activityThrottleMs ?? 5_000;
    this.activityRetentionMs = options.activityRetentionMs ?? 24 * 60 * 60 * 1000;
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
    this.onError = options.onError ?? (() => undefined);
    this.lockStore = new JsonFileStore(options.directory, 'lock.json', { validate: validateLock });
    this.activityStore = new JsonFileStore(options.directory, 'activity.json', {
      validate: validateActivity,
    });
  }

  get isOwner(): boolean {
    return this.owner;
  }

  /** Starts the heartbeat loop. A tick still running when the next one is due is not overlapped. */
  start(): void {
    this.runTick();
    this.timer = setInterval(() => {
      this.runTick();
    }, this.heartbeatIntervalMs);
  }

  /** Renews the heartbeat when owning the lock, or takes over an abandoned lock. */
  async tick(): Promise<void> {
    const lock = await this.lockStore.read();
    if (lock?.windowId === this.windowId) {
      await this.writeLock();
      this.setOwner(true);
    } else if (lock === undefined || this.isAbandoned(lock)) {
      await this.acquire();
    } else {
      this.setOwner(false);
    }
    await this.flushActivity();
  }

  /** Takes ownership even if another window holds the lock (e.g. the user acted in this window). */
  async claim(): Promise<void> {
    await this.acquire();
  }

  /** Whether the lock is held by a live window other than this one. */
  async isLockedByAnotherWindow(): Promise<boolean> {
    const lock = await this.lockStore.read();
    return lock !== undefined && lock.windowId !== this.windowId && !this.isAbandoned(lock);
  }

  /** Records user activity in this window. Writes are throttled; the latest value is never lost. */
  async reportActivity(at: number): Promise<void> {
    this.pendingActivity = Math.max(this.pendingActivity ?? at, at);
    if (this.clock() - this.lastActivityWrite >= this.activityThrottleMs) {
      await this.flushActivity();
    }
  }

  /** The most recent activity across all windows, or `undefined` when none was reported. */
  async latestActivity(): Promise<number | undefined> {
    const activity = await this.activityStore.read();
    const times = [
      ...Object.values(activity?.windows ?? {}),
      this.pendingActivity ?? Number.NEGATIVE_INFINITY,
    ];
    const latest = Math.max(...times);
    return Number.isFinite(latest) ? latest : undefined;
  }

  /** Releases the lock and removes this window's activity entry. */
  async shutdown(): Promise<void> {
    this.stop();
    await this.inFlightTick;
    const lock = await this.lockStore.read();
    if (lock?.windowId === this.windowId) {
      await this.lockStore.delete();
    }
    await this.activityWrites.run(() =>
      this.activityStore.update((current) => ({
        schemaVersion: 1,
        windows: Object.fromEntries(
          Object.entries(current?.windows ?? {}).filter(([id]) => id !== this.windowId),
        ),
      })),
    );
    this.setOwner(false);
  }

  dispose(): void {
    this.stop();
    this.ownershipEmitter.dispose();
  }

  private stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private runTick(): void {
    this.inFlightTick ??= this.tick()
      .catch((error: unknown) => {
        this.onError(error);
      })
      .finally(() => {
        this.inFlightTick = undefined;
      });
  }

  private isAbandoned(lock: LockInfo): boolean {
    return this.clock() - lock.heartbeatAt > this.staleAfterMs || !this.isProcessAlive(lock.pid);
  }

  /** Last writer wins; reading back after a short pause settles windows racing for the lock. */
  private async acquire(): Promise<void> {
    await this.writeLock();
    await this.sleep(this.verifyDelayMs);
    const lock = await this.lockStore.read();
    this.setOwner(lock?.windowId === this.windowId);
  }

  private async writeLock(): Promise<void> {
    await this.lockStore.write({
      schemaVersion: 1,
      windowId: this.windowId,
      pid: this.pid,
      heartbeatAt: this.clock(),
    });
  }

  private async flushActivity(): Promise<void> {
    const at = this.pendingActivity;
    if (at === null) {
      return;
    }
    const now = this.clock();
    this.lastActivityWrite = now;
    this.pendingActivity = null;
    await this.activityWrites.run(() =>
      this.activityStore.update((current) => {
        const windows: Record<string, number> = {};
        for (const [id, time] of Object.entries(current?.windows ?? {})) {
          if (now - time <= this.activityRetentionMs) {
            windows[id] = time;
          }
        }
        windows[this.windowId] = Math.max(windows[this.windowId] ?? at, at);
        return { schemaVersion: 1, windows };
      }),
    );
  }

  private setOwner(owner: boolean): void {
    if (this.owner !== owner) {
      this.owner = owner;
      this.ownershipEmitter.fire(owner);
    }
  }
}
