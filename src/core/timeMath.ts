import type { Segment, Session } from '../types/session';

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const MINUTES_PER_HOUR = 60;

export function segmentDuration(segment: Segment): number {
  return Math.max(0, segment.end - segment.start);
}

export function totalDuration(segments: readonly Segment[]): number {
  return segments.reduce((sum, segment) => sum + segmentDuration(segment), 0);
}

/** Time tracked in the session so far, including the open segment when running. */
export function sessionElapsed(session: Session, now: number): number {
  const open = session.openSegmentStart === null ? 0 : Math.max(0, now - session.openSegmentStart);
  return totalDuration(session.segments) + open;
}

/** Portion of the segments that falls within `[from, to)`. */
export function durationWithin(segments: readonly Segment[], from: number, to: number): number {
  return segments.reduce((sum, { start, end }) => {
    const overlap = Math.min(end, to) - Math.max(start, from);
    return sum + Math.max(0, overlap);
  }, 0);
}

/** Midnight (local time) of the day containing `timestamp`. */
export function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function isSameLocalDay(a: number, b: number): boolean {
  return startOfLocalDay(a) === startOfLocalDay(b);
}

function toWholeSeconds(ms: number): number {
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / MS_PER_SECOND) : 0;
}

/**
 * Formats a duration in milliseconds as `HH:MM:SS` (hours grow past 99 if needed).
 * Negative or non-finite values are treated as zero.
 */
export function formatDuration(ms: number): string {
  const totalSeconds = toWholeSeconds(ms);
  const hours = Math.floor(totalSeconds / SECONDS_PER_HOUR);
  const minutes = Math.floor((totalSeconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const seconds = totalSeconds % SECONDS_PER_MINUTE;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
}

/** Formats a duration as `01h 15m` (seconds are dropped). */
export function formatHoursMinutes(ms: number): string {
  const totalMinutes = Math.floor(toWholeSeconds(ms) / SECONDS_PER_MINUTE);
  const hours = Math.floor(totalMinutes / MINUTES_PER_HOUR);
  const minutes = totalMinutes % MINUTES_PER_HOUR;
  return `${String(hours).padStart(2, '0')}h ${String(minutes).padStart(2, '0')}m`;
}

export function minutesToMs(minutes: number): number {
  return minutes * MS_PER_MINUTE;
}

export function secondsToMs(seconds: number): number {
  return seconds * MS_PER_SECOND;
}
