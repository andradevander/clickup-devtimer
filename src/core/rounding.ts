import type { Segment } from '../types/session';
import { minutesToMs, secondsToMs, segmentDuration, totalDuration } from './timeMath';

export type RoundingMode = 'nearest' | 'up' | 'down';

export interface EntryPolicy {
  /** Sessions shorter than this are discarded. */
  minimumEntrySeconds: number;
  /** Round the session total to a multiple of this; 0 disables rounding. */
  roundingMinutes: number;
  roundingMode: RoundingMode;
  /** Short segments separated by less than this from a neighbour are merged into it. */
  inactivityThresholdSeconds: number;
}

export type PreparedEntries =
  | { kind: 'entries'; segments: Segment[]; trackedMs: number; roundedMs: number }
  | { kind: 'discard'; reason: 'belowMinimum' | 'roundedToZero'; trackedMs: number };

/** Segments shorter than this are not worth a time entry of their own. */
export const MIN_SEGMENT_MS = secondsToMs(60);

/**
 * Turns the tracked segments of a session into the segments that become time entries: merges or
 * drops short segments, applies the minimum duration and rounds the total (spec §3.7).
 */
export function prepareEntries(segments: readonly Segment[], policy: EntryPolicy): PreparedEntries {
  const sorted = segments
    .filter((segment) => segmentDuration(segment) > 0)
    .map((segment) => ({ ...segment }))
    .sort((a, b) => a.start - b.start);
  const trackedMs = totalDuration(sorted);

  if (trackedMs < secondsToMs(policy.minimumEntrySeconds)) {
    return { kind: 'discard', reason: 'belowMinimum', trackedMs };
  }

  const merged = mergeShortSegments(sorted, secondsToMs(policy.inactivityThresholdSeconds));
  const mergedMs = totalDuration(merged);
  if (mergedMs < secondsToMs(policy.minimumEntrySeconds) || mergedMs === 0) {
    return { kind: 'discard', reason: 'belowMinimum', trackedMs };
  }
  const roundedMs = roundTotal(mergedMs, minutesToMs(policy.roundingMinutes), policy.roundingMode);

  if (roundedMs <= 0) {
    return { kind: 'discard', reason: 'roundedToZero', trackedMs };
  }

  return { kind: 'entries', segments: adjustTotal(merged, roundedMs - mergedMs), trackedMs, roundedMs };
}

export function roundTotal(totalMs: number, unitMs: number, mode: RoundingMode): number {
  if (unitMs <= 0) {
    return totalMs;
  }
  const units = totalMs / unitMs;
  const rounded = mode === 'up' ? Math.ceil(units) : mode === 'down' ? Math.floor(units) : Math.round(units);
  return rounded * unitMs;
}

/**
 * Folds each segment shorter than {@link MIN_SEGMENT_MS} into the next segment (or, for the last
 * one, the previous segment) when the gap between them is below `maxGapMs`; otherwise drops it.
 * The duration is preserved and the gap itself is never counted.
 */
function mergeShortSegments(segments: Segment[], maxGapMs: number): Segment[] {
  const result: Segment[] = [];
  let carry: Segment | null = null;

  for (const original of segments) {
    let segment = original;
    if (carry !== null) {
      if (segment.start - carry.end < maxGapMs) {
        // Extend backwards by the carried duration, without counting the gap.
        segment = { start: segment.start - segmentDuration(carry), end: segment.end };
      }
      carry = null;
    }
    if (segmentDuration(segment) < MIN_SEGMENT_MS) {
      carry = segment;
    } else {
      result.push(segment);
    }
  }

  if (carry !== null) {
    const previous = result.at(-1);
    if (previous !== undefined && carry.start - previous.end < maxGapMs) {
      previous.end += segmentDuration(carry);
    }
  }

  return result;
}

/**
 * Applies the rounding difference: extends the last segment, or trims from the end backwards.
 * Expects at least one segment.
 */
function adjustTotal(segments: Segment[], deltaMs: number): Segment[] {
  const result = segments.map((segment) => ({ ...segment }));
  if (deltaMs >= 0) {
    const last = result.at(-1);
    if (last !== undefined) {
      last.end += deltaMs;
    }
    return result;
  }

  let remaining = -deltaMs;
  for (const segment of result.toReversed()) {
    const cut = Math.min(remaining, segmentDuration(segment));
    segment.end -= cut;
    remaining -= cut;
  }
  return result.filter((segment) => segmentDuration(segment) > 0);
}
