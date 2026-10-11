import { describe, expect, it } from 'vitest';
import {
  finalSegments,
  markPersisted,
  normalizeClock,
  pauseSession,
  recordActivity,
  recoverSession,
  resumeSession,
  startSession,
} from '../../../src/core/stateMachine';
import { sessionElapsed } from '../../../src/core/timeMath';
import { MINUTE, T0, task } from './fixtures';

describe('startSession', () => {
  it('starts running with an open segment', () => {
    const session = startSession(task, T0);
    expect(session).toMatchObject({
      schemaVersion: 1,
      task,
      status: 'running',
      segments: [],
      openSegmentStart: T0,
      pausedAt: null,
      lastActivityTime: T0,
      lastPersistedAt: T0,
    });
  });
});

describe('recordActivity', () => {
  it('moves the last activity forward only', () => {
    const session = startSession(task, T0);
    expect(recordActivity(session, T0 + MINUTE).lastActivityTime).toBe(T0 + MINUTE);
    expect(recordActivity(session, T0 - MINUTE)).toBe(session);
  });
});

describe('pauseSession', () => {
  it('closes the open segment at now on a manual pause', () => {
    const paused = pauseSession(startSession(task, T0), T0 + 10 * MINUTE, 'manual');
    expect(paused.status).toBe('pausedManual');
    expect(paused.segments).toEqual([{ start: T0, end: T0 + 10 * MINUTE }]);
    expect(paused.openSegmentStart).toBeNull();
    expect(paused.pausedAt).toBe(T0 + 10 * MINUTE);
  });

  it('closes the open segment at the last activity on an idle pause, discounting idle time', () => {
    const active = recordActivity(startSession(task, T0), T0 + 10 * MINUTE);
    const paused = pauseSession(active, T0 + 12 * MINUTE, 'idle');
    expect(paused.status).toBe('pausedIdle');
    expect(paused.segments).toEqual([{ start: T0, end: T0 + 10 * MINUTE }]);
    expect(paused.pausedAt).toBe(T0 + 10 * MINUTE);
  });

  it('clamps an idle pause to the open segment', () => {
    const resumed = resumeSession(
      pauseSession(startSession(task, T0), T0 + MINUTE, 'manual'),
      T0 + 5 * MINUTE,
    );
    // Last activity equals the resume time, so an idle pause right away yields no segment.
    const paused = pauseSession(resumed, T0 + 8 * MINUTE, 'idle');
    expect(paused.segments).toEqual([{ start: T0, end: T0 + MINUTE }]);
  });

  it('does not record empty segments', () => {
    const paused = pauseSession(startSession(task, T0), T0, 'manual');
    expect(paused.segments).toEqual([]);
  });

  it('is a no-op when already paused', () => {
    const paused = pauseSession(startSession(task, T0), T0 + MINUTE, 'manual');
    expect(pauseSession(paused, T0 + 2 * MINUTE, 'idle')).toBe(paused);
  });
});

describe('resumeSession', () => {
  it('opens a new segment at now', () => {
    const paused = pauseSession(startSession(task, T0), T0 + MINUTE, 'manual');
    const resumed = resumeSession(paused, T0 + 5 * MINUTE);
    expect(resumed.status).toBe('running');
    expect(resumed.openSegmentStart).toBe(T0 + 5 * MINUTE);
    expect(resumed.pausedAt).toBeNull();
    expect(resumed.lastActivityTime).toBe(T0 + 5 * MINUTE);
    expect(sessionElapsed(resumed, T0 + 7 * MINUTE)).toBe(3 * MINUTE);
  });

  it('is a no-op when running', () => {
    const session = startSession(task, T0);
    expect(resumeSession(session, T0 + MINUTE)).toBe(session);
  });
});

describe('finalSegments', () => {
  it('closes the open segment at now', () => {
    const paused = pauseSession(startSession(task, T0), T0 + MINUTE, 'manual');
    const resumed = resumeSession(paused, T0 + 2 * MINUTE);
    expect(finalSegments(resumed, T0 + 4 * MINUTE)).toEqual([
      { start: T0, end: T0 + MINUTE },
      { start: T0 + 2 * MINUTE, end: T0 + 4 * MINUTE },
    ]);
  });

  it('returns a copy of the closed segments when paused', () => {
    const paused = pauseSession(startSession(task, T0), T0 + MINUTE, 'manual');
    const segments = finalSegments(paused, T0 + 10 * MINUTE);
    expect(segments).toEqual(paused.segments);
    expect(segments).not.toBe(paused.segments);
  });

  it('skips an empty open segment', () => {
    expect(finalSegments(startSession(task, T0), T0 - MINUTE)).toEqual([]);
  });
});

describe('recoverSession', () => {
  it('closes the open segment at the last activity and leaves the session paused', () => {
    const session = recordActivity(startSession(task, T0), T0 + 30 * MINUTE);
    const recovered = recoverSession(session);
    expect(recovered.status).toBe('pausedIdle');
    expect(recovered.segments).toEqual([{ start: T0, end: T0 + 30 * MINUTE }]);
    expect(recovered.openSegmentStart).toBeNull();
    expect(recovered.pausedAt).toBe(T0 + 30 * MINUTE);
  });

  it('keeps a paused session as is', () => {
    const paused = pauseSession(startSession(task, T0), T0 + MINUTE, 'manual');
    expect(recoverSession(paused)).toBe(paused);
  });
});

describe('normalizeClock', () => {
  it('does nothing when the clock moved forward', () => {
    const session = startSession(task, T0);
    expect(normalizeClock(session, T0 + MINUTE)).toBe(session);
  });

  it('splits the open segment when the clock moved backwards', () => {
    const session = markPersisted(recordActivity(startSession(task, T0), T0 + 10 * MINUTE), T0 + 10 * MINUTE);
    const now = T0 + 5 * MINUTE;
    const normalized = normalizeClock(session, now);
    expect(normalized.segments).toEqual([{ start: T0, end: T0 + 10 * MINUTE }]);
    expect(normalized.openSegmentStart).toBe(now);
    expect(normalized.lastActivityTime).toBe(now);
    expect(normalized.lastPersistedAt).toBe(now);
    expect(sessionElapsed(normalized, now + MINUTE)).toBe(11 * MINUTE);
  });

  it('only resets timestamps of a paused session', () => {
    const paused = markPersisted(
      pauseSession(startSession(task, T0), T0 + 10 * MINUTE, 'manual'),
      T0 + 10 * MINUTE,
    );
    const normalized = normalizeClock(paused, T0 + 5 * MINUTE);
    expect(normalized.segments).toEqual(paused.segments);
    expect(normalized.openSegmentStart).toBeNull();
    expect(normalized.lastPersistedAt).toBe(T0 + 5 * MINUTE);
    expect(normalized.lastActivityTime).toBe(T0);
  });
});
