/** A continuous stretch of tracked time, in epoch milliseconds. `end` is exclusive. */
export interface Segment {
  start: number;
  end: number;
}

export interface TaskRef {
  /** Internal ClickUp task ID (always used for API calls). */
  id: string;
  /** Workspace-level custom task ID (e.g. `DEV-123`), when enabled. */
  customId?: string;
  name: string;
  url: string;
  listId: string;
  teamId: string;
}

export type SessionStatus = 'running' | 'pausedManual' | 'pausedIdle';

export type PauseReason = 'manual' | 'idle';

export interface Session {
  schemaVersion: 1;
  /** Unique per session; lets crash recovery tell whether the session was already queued for sync. */
  id: string;
  task: TaskRef;
  status: SessionStatus;
  /** Closed segments, in chronological order. */
  segments: Segment[];
  /** Start of the segment being tracked right now; `null` while paused. */
  openSegmentStart: number | null;
  /** When the current pause began; `null` while running. */
  pausedAt: number | null;
  /** Most recent user activity seen in any window. */
  lastActivityTime: number;
  /** When the session was last written to disk. */
  lastPersistedAt: number;
}

/** Contents of `state.json` (spec §5). */
export interface PersistedState {
  schemaVersion: 1;
  session: Session | null;
  /** Most recently used first. */
  recentTasks: TaskRef[];
  /** Branches for which the user chose "don't ask again". */
  ignoredBranches: string[];
}

/** Contents of `lock.json`: which window runs the background work (spec §2.2-E). */
export interface LockInfo {
  schemaVersion: 1;
  windowId: string;
  pid: number;
  heartbeatAt: number;
}

/** Contents of `activity.json`: last activity per window. */
export interface ActivityFile {
  schemaVersion: 1;
  windows: Record<string, number>;
}

export type QueueItemStatus = 'pending' | 'failed';

/** A time entry waiting to be sent to ClickUp (spec §2.2-F). */
export interface QueueItem {
  id: string;
  sessionId: string;
  teamId: string;
  taskId: string;
  /** For display in "Show Pending Sync". */
  taskName: string;
  start: number;
  duration: number;
  description: string;
  status: QueueItemStatus;
  attempts: number;
  nextAttemptAt: number;
  /** A previous attempt may have reached ClickUp; check for the entry before sending again. */
  outcomeUnknown: boolean;
  lastError: { kind: string; message: string } | null;
  createdAt: number;
}

/** Contents of `queue.json`. */
export interface QueueFile {
  schemaVersion: 1;
  items: QueueItem[];
}
