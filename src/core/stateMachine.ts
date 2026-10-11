import type { PauseReason, Segment, Session, TaskRef } from '../types/session';

/*
 * Pure session transitions. Every function returns a new Session (or the same instance when the
 * transition does not apply), so callers can compare by reference to know whether anything changed.
 */

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function withClosedSegment(segments: readonly Segment[], segment: Segment): Segment[] {
  return segment.end > segment.start ? [...segments, segment] : [...segments];
}

export function startSession(task: TaskRef, now: number): Session {
  return {
    schemaVersion: 1,
    task,
    status: 'running',
    segments: [],
    openSegmentStart: now,
    pausedAt: null,
    lastActivityTime: now,
    lastPersistedAt: now,
  };
}

export function recordActivity(session: Session, at: number): Session {
  return at > session.lastActivityTime ? { ...session, lastActivityTime: at } : session;
}

/**
 * Pauses a running session. A manual pause closes the open segment at `now`; an idle pause closes it
 * at the last activity, so the idle stretch is never counted.
 */
export function pauseSession(session: Session, now: number, reason: PauseReason): Session {
  if (session.status !== 'running' || session.openSegmentStart === null) {
    return session;
  }
  const start = session.openSegmentStart;
  const end = reason === 'idle' ? clamp(session.lastActivityTime, start, now) : now;
  return {
    ...session,
    status: reason === 'idle' ? 'pausedIdle' : 'pausedManual',
    segments: withClosedSegment(session.segments, { start, end }),
    openSegmentStart: null,
    pausedAt: end,
  };
}

export function resumeSession(session: Session, now: number): Session {
  if (session.status === 'running') {
    return session;
  }
  return {
    ...session,
    status: 'running',
    openSegmentStart: now,
    pausedAt: null,
    lastActivityTime: Math.max(session.lastActivityTime, now),
  };
}

/** All tracked segments, closing the open one at `now`. Used when finishing or switching tasks. */
export function finalSegments(session: Session, now: number): Segment[] {
  if (session.openSegmentStart === null) {
    return [...session.segments];
  }
  return withClosedSegment(session.segments, {
    start: session.openSegmentStart,
    end: Math.max(session.openSegmentStart, now),
  });
}

/**
 * Restores a session found on disk after a crash or after every window was closed. The open segment
 * is closed at the last activity, so the time the editor was closed is not counted, and the session
 * is left paused until the user decides what to do with it.
 */
export function recoverSession(session: Session): Session {
  if (session.openSegmentStart === null) {
    return session;
  }
  const start = session.openSegmentStart;
  const end = Math.max(start, session.lastActivityTime);
  return {
    ...session,
    status: 'pausedIdle',
    segments: withClosedSegment(session.segments, { start, end }),
    openSegmentStart: null,
    pausedAt: end,
  };
}

/**
 * Handles the system clock moving backwards. The open segment is closed at the last persisted time
 * and a new one starts at `now`, so the tracked duration stays correct.
 */
export function normalizeClock(session: Session, now: number): Session {
  if (now >= session.lastPersistedAt) {
    return session;
  }
  const lastActivityTime = Math.min(session.lastActivityTime, now);
  if (session.openSegmentStart === null) {
    return { ...session, lastActivityTime, lastPersistedAt: now };
  }
  return {
    ...session,
    segments: withClosedSegment(session.segments, {
      start: session.openSegmentStart,
      end: Math.max(session.openSegmentStart, session.lastPersistedAt),
    }),
    openSegmentStart: now,
    lastActivityTime: now,
    lastPersistedAt: now,
  };
}

export function markPersisted(session: Session, now: number): Session {
  return { ...session, lastPersistedAt: now };
}
