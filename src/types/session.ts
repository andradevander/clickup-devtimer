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
