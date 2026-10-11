import type {
  ActivityFile,
  LockInfo,
  PersistedState,
  QueueFile,
  QueueItem,
  Segment,
  Session,
  TaskRef,
} from '../types/session';

/*
 * Shape checks for the JSON files in the storage directory. Each validator returns the value when it
 * is well-formed or `undefined` otherwise, so a hand-edited or incompatible file is treated as
 * missing instead of crashing the extension.
 */

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || isNumber(value);
}

function isArrayOf<T>(value: unknown, guard: (item: unknown) => item is T): value is T[] {
  return Array.isArray(value) && value.every(guard);
}

function hasSchemaVersion1(value: Json): boolean {
  return value.schemaVersion === 1;
}

export function isSegment(value: unknown): value is Segment {
  return isObject(value) && isNumber(value.start) && isNumber(value.end);
}

export function isTaskRef(value: unknown): value is TaskRef {
  return (
    isObject(value) &&
    isString(value.id) &&
    (value.customId === undefined || isString(value.customId)) &&
    isString(value.name) &&
    isString(value.url) &&
    isString(value.listId) &&
    isString(value.teamId)
  );
}

const SESSION_STATUSES = new Set(['running', 'pausedManual', 'pausedIdle']);

export function isSession(value: unknown): value is Session {
  if (!isObject(value) || !hasSchemaVersion1(value)) {
    return false;
  }
  const consistent =
    value.status === 'running'
      ? isNumber(value.openSegmentStart) && value.pausedAt === null
      : value.openSegmentStart === null;
  return (
    isString(value.id) &&
    isTaskRef(value.task) &&
    isString(value.status) &&
    SESSION_STATUSES.has(value.status) &&
    isArrayOf(value.segments, isSegment) &&
    isNullableNumber(value.openSegmentStart) &&
    isNullableNumber(value.pausedAt) &&
    isNumber(value.lastActivityTime) &&
    isNumber(value.lastPersistedAt) &&
    consistent
  );
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return isObject(value) && Object.values(value).every(isNumber);
}

export function validatePersistedState(value: unknown): PersistedState | undefined {
  if (!isObject(value) || !hasSchemaVersion1(value)) {
    return undefined;
  }
  // Optional for compatibility with files written before daily totals existed.
  const dailyTotals = value.dailyTotals ?? {};
  const valid =
    (value.session === null || isSession(value.session)) &&
    isArrayOf(value.recentTasks, isTaskRef) &&
    isArrayOf(value.ignoredBranches, isString) &&
    isNumberRecord(dailyTotals);
  return valid ? ({ ...value, dailyTotals } as unknown as PersistedState) : undefined;
}

export function validateLock(value: unknown): LockInfo | undefined {
  const valid =
    isObject(value) &&
    hasSchemaVersion1(value) &&
    isString(value.windowId) &&
    isNumber(value.pid) &&
    isNumber(value.heartbeatAt);
  return valid ? (value as unknown as LockInfo) : undefined;
}

export function validateActivity(value: unknown): ActivityFile | undefined {
  const valid =
    isObject(value) &&
    hasSchemaVersion1(value) &&
    isObject(value.windows) &&
    Object.values(value.windows).every(isNumber);
  return valid ? (value as unknown as ActivityFile) : undefined;
}

function isLastError(value: unknown): boolean {
  return value === null || (isObject(value) && isString(value.kind) && isString(value.message));
}

export function isQueueItem(value: unknown): value is QueueItem {
  return (
    isObject(value) &&
    isString(value.id) &&
    isString(value.sessionId) &&
    isString(value.teamId) &&
    isString(value.taskId) &&
    isString(value.taskName) &&
    isNumber(value.start) &&
    isNumber(value.duration) &&
    isString(value.description) &&
    (value.status === 'pending' || value.status === 'failed') &&
    isNumber(value.attempts) &&
    isNumber(value.nextAttemptAt) &&
    typeof value.outcomeUnknown === 'boolean' &&
    isNumber(value.leaseUntil) &&
    isLastError(value.lastError) &&
    isNumber(value.createdAt)
  );
}

export function validateQueue(value: unknown): QueueFile | undefined {
  const valid = isObject(value) && hasSchemaVersion1(value) && isArrayOf(value.items, isQueueItem);
  return valid ? (value as unknown as QueueFile) : undefined;
}
