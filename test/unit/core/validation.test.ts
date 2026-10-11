import { describe, expect, it } from 'vitest';
import { pauseSession, startSession } from '../../../src/core/stateMachine';
import {
  isSession,
  isTaskRef,
  validateActivity,
  validateLock,
  validatePersistedState,
  validateQueue,
} from '../../../src/core/validation';
import type { QueueItem } from '../../../src/types/session';
import { MINUTE, SESSION_ID, T0, task } from './fixtures';

const running = startSession(task, T0, SESSION_ID);
const paused = pauseSession(running, T0 + MINUTE, 'manual');

const queueItem: QueueItem = {
  id: 'q1',
  sessionId: SESSION_ID,
  teamId: '9000',
  taskId: task.id,
  taskName: task.name,
  start: T0,
  duration: MINUTE,
  description: 'desc',
  status: 'pending',
  attempts: 0,
  nextAttemptAt: T0,
  outcomeUnknown: false,
  leaseUntil: 0,
  lastError: null,
  createdAt: T0,
};

describe('isTaskRef', () => {
  it('accepts tasks with and without a custom ID', () => {
    expect(isTaskRef(task)).toBe(true);
    expect(isTaskRef({ ...task, customId: 'DEV-1' })).toBe(true);
  });

  it.each([null, 'x', [], { ...task, id: 1 }, { ...task, customId: 5 }, { ...task, teamId: undefined }])(
    'rejects %j',
    (value) => {
      expect(isTaskRef(value)).toBe(false);
    },
  );
});

describe('isSession', () => {
  it('accepts running and paused sessions', () => {
    expect(isSession(running)).toBe(true);
    expect(isSession(paused)).toBe(true);
  });

  it.each([
    ['wrong schema version', { ...running, schemaVersion: 2 }],
    ['unknown status', { ...running, status: 'stopped' }],
    ['running without an open segment', { ...running, openSegmentStart: null }],
    ['running with pausedAt', { ...running, pausedAt: T0 }],
    ['paused with an open segment', { ...paused, openSegmentStart: T0 }],
    ['invalid segment', { ...paused, segments: [{ start: 'a', end: 1 }] }],
    ['non-finite timestamp', { ...running, lastActivityTime: Number.NaN }],
    ['invalid task', { ...running, task: {} }],
  ])('rejects a session with %s', (_label, value) => {
    expect(isSession(value)).toBe(false);
  });
});

describe('validatePersistedState', () => {
  const state = {
    schemaVersion: 1,
    session: running,
    recentTasks: [task],
    ignoredBranches: ['main'],
    dailyTotals: { '2026-01-15': 3_600_000 },
  };

  it('accepts a valid state, with or without a session', () => {
    expect(validatePersistedState(state)).toEqual(state);
    expect(validatePersistedState({ ...state, session: null })).toBeDefined();
  });

  it('defaults missing daily totals', () => {
    const withoutTotals: Partial<typeof state> = { ...state };
    delete withoutTotals.dailyTotals;
    expect(validatePersistedState(withoutTotals)).toEqual({ ...state, dailyTotals: {} });
  });

  it.each([
    null,
    [],
    { ...state, schemaVersion: 2 },
    { ...state, session: { id: 'x' } },
    { ...state, recentTasks: [{}] },
    { ...state, ignoredBranches: [1] },
    { ...state, dailyTotals: { '2026-01-15': 'x' } },
  ])('rejects %j', (value) => {
    expect(validatePersistedState(value)).toBeUndefined();
  });
});

describe('validateLock', () => {
  const lock = { schemaVersion: 1, windowId: 'w1', pid: 123, heartbeatAt: T0 };

  it('accepts a valid lock', () => {
    expect(validateLock(lock)).toBe(lock);
  });

  it.each([
    { ...lock, pid: '123' },
    { ...lock, windowId: null },
    { ...lock, schemaVersion: 0 },
  ])('rejects %j', (value) => {
    expect(validateLock(value)).toBeUndefined();
  });
});

describe('validateActivity', () => {
  it('accepts a valid activity file', () => {
    const activity = { schemaVersion: 1, windows: { w1: T0 } };
    expect(validateActivity(activity)).toBe(activity);
  });

  it.each([
    { schemaVersion: 1, windows: { w1: 'x' } },
    { schemaVersion: 1, windows: [] },
    { schemaVersion: 1 },
  ])('rejects %j', (value) => {
    expect(validateActivity(value)).toBeUndefined();
  });
});

describe('validateQueue', () => {
  it('accepts a valid queue', () => {
    const queue = {
      schemaVersion: 1,
      items: [queueItem, { ...queueItem, status: 'failed', lastError: { kind: 'client', message: 'bad' } }],
    };
    expect(validateQueue(queue)).toBe(queue);
  });

  it.each([
    { ...queueItem, status: 'done' },
    { ...queueItem, outcomeUnknown: 'no' },
    { ...queueItem, leaseUntil: null },
    { ...queueItem, lastError: { kind: 'client' } },
    { ...queueItem, duration: undefined },
  ])('rejects an item %#', (item) => {
    expect(validateQueue({ schemaVersion: 1, items: [item] })).toBeUndefined();
  });
});
