import { describe, expect, it } from 'vitest';
import { startSession, pauseSession } from '../../../src/core/stateMachine';
import {
  durationWithin,
  formatDuration,
  formatHoursMinutes,
  isSameLocalDay,
  minutesToMs,
  secondsToMs,
  segmentDuration,
  sessionElapsed,
  startOfLocalDay,
  totalDuration,
} from '../../../src/core/timeMath';
import { HOUR, MINUTE, SESSION_ID, T0, task } from './fixtures';

describe('formatDuration', () => {
  it.each([
    [0, '00:00:00'],
    [999, '00:00:00'],
    [1_000, '00:00:01'],
    [59_000, '00:00:59'],
    [60_000, '00:01:00'],
    [5_025_000, '01:23:45'],
    [36_000_000, '10:00:00'],
    [360_000_000, '100:00:00'],
  ])('formats %i ms as %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  it.each([-1, -60_000, Number.NaN, Number.POSITIVE_INFINITY])('treats invalid value %s as zero', (ms) => {
    expect(formatDuration(ms)).toBe('00:00:00');
  });
});

describe('formatHoursMinutes', () => {
  it.each([
    [0, '00h 00m'],
    [59_999, '00h 00m'],
    [MINUTE, '00h 01m'],
    [HOUR + 15 * MINUTE + 59_000, '01h 15m'],
    [125 * HOUR, '125h 00m'],
    [-MINUTE, '00h 00m'],
  ])('formats %i ms as %s', (ms, expected) => {
    expect(formatHoursMinutes(ms)).toBe(expected);
  });
});

describe('durations', () => {
  it('ignores inverted segments', () => {
    expect(segmentDuration({ start: 10, end: 5 })).toBe(0);
  });

  it('sums segments', () => {
    expect(
      totalDuration([
        { start: 0, end: 100 },
        { start: 200, end: 250 },
      ]),
    ).toBe(150);
    expect(totalDuration([])).toBe(0);
  });

  it('counts the open segment of a running session', () => {
    const session = startSession(task, T0, SESSION_ID);
    expect(sessionElapsed(session, T0 + 5 * MINUTE)).toBe(5 * MINUTE);
  });

  it('counts only closed segments of a paused session', () => {
    const paused = pauseSession(startSession(task, T0, SESSION_ID), T0 + 10 * MINUTE, 'manual');
    expect(sessionElapsed(paused, T0 + HOUR)).toBe(10 * MINUTE);
  });

  it('never returns negative elapsed time when the clock is behind the open segment', () => {
    expect(sessionElapsed(startSession(task, T0, SESSION_ID), T0 - MINUTE)).toBe(0);
  });

  it('clips segments to a range', () => {
    const segments = [
      { start: 0, end: 100 },
      { start: 150, end: 300 },
      { start: 400, end: 500 },
    ];
    expect(durationWithin(segments, 50, 200)).toBe(50 + 50);
    expect(durationWithin(segments, 600, 700)).toBe(0);
  });

  it('converts units', () => {
    expect(minutesToMs(2)).toBe(120_000);
    expect(secondsToMs(3)).toBe(3_000);
  });
});

describe('local days', () => {
  it('finds the start of the local day', () => {
    expect(startOfLocalDay(T0)).toBe(new Date(2026, 0, 15).getTime());
  });

  it('compares local days', () => {
    const lateNight = new Date(2026, 0, 15, 23, 59).getTime();
    const nextMorning = new Date(2026, 0, 16, 0, 1).getTime();
    expect(isSameLocalDay(T0, lateNight)).toBe(true);
    expect(isSameLocalDay(lateNight, nextMorning)).toBe(false);
  });
});
