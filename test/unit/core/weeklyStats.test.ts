import { describe, expect, it } from 'vitest';
import {
  addLoggedEntries,
  localWeekKey,
  markSummaryShown,
  pendingWeeklySummary,
  previousWeekKey,
} from '../../../src/core/weeklyStats';
import type { StatsFile } from '../../../src/types/stats';
import { HOUR, MINUTE } from './fixtures';

/** Local time, so the tests do not depend on the machine's time zone. */
const at = (year: number, month: number, day: number, hour = 9) =>
  new Date(year, month - 1, day, hour).getTime();

// 2026-01-12 is a Monday.
const MONDAY = at(2026, 1, 12);
const NEXT_MONDAY = at(2026, 1, 19);

describe('localWeekKey', () => {
  it.each([
    [at(2026, 1, 12, 0), '2026-01-12'],
    [at(2026, 1, 14), '2026-01-12'],
    [at(2026, 1, 18, 23), '2026-01-12'],
    [at(2026, 1, 19, 0), '2026-01-19'],
    // Crosses a month and a year.
    [at(2026, 1, 1), '2025-12-29'],
  ])('maps %i to the week starting %s', (timestamp, key) => {
    expect(localWeekKey(timestamp)).toBe(key);
  });

  it('gives the previous week', () => {
    expect(previousWeekKey(at(2026, 1, 21))).toBe('2026-01-12');
    expect(previousWeekKey(at(2026, 1, 5))).toBe('2025-12-29');
  });
});

describe('addLoggedEntries', () => {
  it('tallies time and distinct tasks per week of the entry start', () => {
    const stats = addLoggedEntries(
      undefined,
      [
        { taskId: 'a', start: MONDAY, duration: HOUR },
        { taskId: 'b', start: MONDAY + HOUR, duration: 30 * MINUTE },
        { taskId: 'a', start: MONDAY + 2 * HOUR, duration: 15 * MINUTE },
      ],
      MONDAY + 3 * HOUR,
    );
    expect(stats).toEqual({
      schemaVersion: 1,
      weeks: { '2026-01-12': { totalMs: HOUR + 45 * MINUTE, taskIds: ['a', 'b'], summaryShown: false } },
    });
  });

  it('keeps a week marked as shown when adding to it', () => {
    const shown = markSummaryShown(undefined, '2026-01-12', NEXT_MONDAY);
    const later = addLoggedEntries(shown, [{ taskId: 'a', start: MONDAY, duration: HOUR }], NEXT_MONDAY);
    expect(later.weeks['2026-01-12']).toEqual({ totalMs: HOUR, taskIds: ['a'], summaryShown: true });
  });

  it('adds to an existing week', () => {
    const first = addLoggedEntries(undefined, [{ taskId: 'a', start: MONDAY, duration: HOUR }], MONDAY);
    const second = addLoggedEntries(first, [{ taskId: 'c', start: MONDAY + HOUR, duration: HOUR }], MONDAY);
    expect(second.weeks['2026-01-12']).toEqual({
      totalMs: 2 * HOUR,
      taskIds: ['a', 'c'],
      summaryShown: false,
    });
  });

  it('keeps only the current and previous weeks', () => {
    const old = addLoggedEntries(
      undefined,
      [
        { taskId: 'a', start: MONDAY - 7 * 24 * HOUR, duration: HOUR },
        { taskId: 'b', start: MONDAY, duration: HOUR },
      ],
      MONDAY,
    );
    expect(Object.keys(old.weeks).sort()).toEqual(['2026-01-05', '2026-01-12']);

    const later = addLoggedEntries(old, [{ taskId: 'c', start: NEXT_MONDAY, duration: HOUR }], NEXT_MONDAY);
    expect(Object.keys(later.weeks).sort()).toEqual(['2026-01-12', '2026-01-19']);
  });

  it('ignores entries outside the kept weeks and empty durations', () => {
    const stats = addLoggedEntries(
      undefined,
      [
        { taskId: 'a', start: MONDAY - 14 * 24 * HOUR, duration: HOUR },
        { taskId: 'b', start: MONDAY, duration: 0 },
      ],
      MONDAY,
    );
    expect(stats.weeks).toEqual({});
  });
});

describe('pendingWeeklySummary', () => {
  const lastWeek: StatsFile = {
    schemaVersion: 1,
    weeks: { '2026-01-12': { totalMs: 3 * HOUR, taskIds: ['a', 'b'], summaryShown: false } },
  };

  it('offers last week once a new week starts', () => {
    expect(pendingWeeklySummary(lastWeek, NEXT_MONDAY)).toEqual({
      weekKey: '2026-01-12',
      totalMs: 3 * HOUR,
      taskCount: 2,
    });
  });

  it('does not offer the current week', () => {
    expect(pendingWeeklySummary(lastWeek, MONDAY + HOUR)).toBeUndefined();
  });

  it('does not offer it twice', () => {
    const shown = markSummaryShown(lastWeek, '2026-01-12', NEXT_MONDAY);
    expect(shown.weeks['2026-01-12']?.summaryShown).toBe(true);
    expect(pendingWeeklySummary(shown, NEXT_MONDAY)).toBeUndefined();
  });

  it('does not offer an empty or missing week', () => {
    expect(pendingWeeklySummary(undefined, NEXT_MONDAY)).toBeUndefined();
    const empty: StatsFile = {
      schemaVersion: 1,
      weeks: { '2026-01-12': { totalMs: 0, taskIds: [], summaryShown: false } },
    };
    expect(pendingWeeklySummary(empty, NEXT_MONDAY)).toBeUndefined();
    // Two weeks later, "last week" had nothing.
    expect(pendingWeeklySummary(lastWeek, NEXT_MONDAY + 7 * 24 * HOUR)).toBeUndefined();
  });

  it('marks a week without a tally as shown', () => {
    expect(markSummaryShown(undefined, '2026-01-12', NEXT_MONDAY).weeks['2026-01-12']).toEqual({
      totalMs: 0,
      taskIds: [],
      summaryShown: true,
    });
  });
});
