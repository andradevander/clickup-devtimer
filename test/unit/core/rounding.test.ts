import { describe, expect, it } from 'vitest';
import { prepareEntries, roundTotal, type EntryPolicy } from '../../../src/core/rounding';
import { totalDuration } from '../../../src/core/timeMath';
import { MINUTE, SECOND, T0 } from './fixtures';

const noRounding: EntryPolicy = {
  minimumEntrySeconds: 60,
  roundingMinutes: 0,
  roundingMode: 'nearest',
  inactivityThresholdSeconds: 120,
};

const fiveMinutes: EntryPolicy = { ...noRounding, roundingMinutes: 5 };

function seg(startMin: number, endMin: number) {
  return { start: T0 + startMin * MINUTE, end: T0 + endMin * MINUTE };
}

describe('roundTotal', () => {
  const unit = 5 * MINUTE;

  it.each([
    ['nearest', 12 * MINUTE, 10 * MINUTE],
    ['nearest', 12.5 * MINUTE, 15 * MINUTE],
    ['nearest', 13 * MINUTE, 15 * MINUTE],
    ['up', 10 * MINUTE + 1, 15 * MINUTE],
    ['up', 10 * MINUTE, 10 * MINUTE],
    ['down', 14 * MINUTE, 10 * MINUTE],
  ] as const)('%s rounds %i to %i', (mode, total, expected) => {
    expect(roundTotal(total, unit, mode)).toBe(expected);
  });

  it('returns the total unchanged when rounding is disabled', () => {
    expect(roundTotal(123_456, 0, 'nearest')).toBe(123_456);
  });
});

describe('prepareEntries', () => {
  it('keeps one entry per continuous segment without rounding', () => {
    const result = prepareEntries([seg(0, 30), seg(45, 60)], noRounding);
    expect(result).toEqual({
      kind: 'entries',
      segments: [seg(0, 30), seg(45, 60)],
      trackedMs: 45 * MINUTE,
      roundedMs: 45 * MINUTE,
    });
  });

  it('sorts segments and drops empty ones', () => {
    const result = prepareEntries([seg(45, 60), seg(10, 10), seg(0, 30)], noRounding);
    expect(result.kind === 'entries' && result.segments).toEqual([seg(0, 30), seg(45, 60)]);
  });

  it('discards sessions below the minimum', () => {
    expect(prepareEntries([{ start: T0, end: T0 + 59 * SECOND }], noRounding)).toEqual({
      kind: 'discard',
      reason: 'belowMinimum',
      trackedMs: 59 * SECOND,
    });
    expect(prepareEntries([], noRounding)).toMatchObject({ kind: 'discard', reason: 'belowMinimum' });
  });

  it('discards sessions that round to zero', () => {
    expect(prepareEntries([seg(0, 2)], fiveMinutes)).toEqual({
      kind: 'discard',
      reason: 'roundedToZero',
      trackedMs: 2 * MINUTE,
    });
  });

  it('extends the last segment when rounding up', () => {
    const result = prepareEntries([seg(0, 10), seg(20, 33)], fiveMinutes);
    expect(result).toEqual({
      kind: 'entries',
      segments: [seg(0, 10), seg(20, 35)],
      trackedMs: 23 * MINUTE,
      roundedMs: 25 * MINUTE,
    });
  });

  it('trims from the end backwards when rounding down', () => {
    const result = prepareEntries([seg(0, 10), seg(20, 21.5)], { ...fiveMinutes, roundingMode: 'down' });
    // 11.5 min -> 10 min: the 1.5 min last segment is removed entirely.
    expect(result).toEqual({
      kind: 'entries',
      segments: [seg(0, 10)],
      trackedMs: 11.5 * MINUTE,
      roundedMs: 10 * MINUTE,
    });
  });

  it('trims across several segments when needed', () => {
    const result = prepareEntries([seg(0, 8), seg(10, 11.5), seg(13, 14.5)], {
      ...fiveMinutes,
      roundingMode: 'down',
    });
    // 11 min -> 10 min.
    expect(result.kind === 'entries' && result.segments).toEqual([seg(0, 8), seg(10, 11.5), seg(13, 13.5)]);
  });

  it('merges a short segment into the next one when the gap is below the idle threshold', () => {
    const result = prepareEntries([{ start: T0, end: T0 + 30 * SECOND }, seg(1, 10)], noRounding);
    // The 30 s are added to the next segment, the 30 s gap is not counted.
    expect(result.kind === 'entries' && result.segments).toEqual([
      { start: T0 + 30 * SECOND, end: T0 + 10 * MINUTE },
    ]);
    expect(result.kind === 'entries' && result.roundedMs).toBe(9.5 * MINUTE);
  });

  it('merges a trailing short segment into the previous one', () => {
    const result = prepareEntries(
      [seg(0, 10), { start: T0 + 11 * MINUTE, end: T0 + 11 * MINUTE + 20 * SECOND }],
      noRounding,
    );
    expect(result.kind === 'entries' && result.segments).toEqual([
      { start: T0, end: T0 + 10 * MINUTE + 20 * SECOND },
    ]);
  });

  it('chains consecutive short segments', () => {
    const short = (startSec: number) => ({
      start: T0 + startSec * SECOND,
      end: T0 + (startSec + 40) * SECOND,
    });
    const result = prepareEntries([short(0), short(50), seg(2, 5)], noRounding);
    // The first 40 s fold into the second short segment, which then reaches 80 s and stands on its own.
    expect(result.kind === 'entries' && result.segments).toEqual([
      { start: T0 + 10 * SECOND, end: T0 + 90 * SECOND },
      seg(2, 5),
    ]);
    expect(result.kind === 'entries' && totalDuration(result.segments)).toBe(3 * MINUTE + 80 * SECOND);
  });

  it('drops short segments far from any other segment', () => {
    const result = prepareEntries(
      [seg(0, 10), { start: T0 + 30 * MINUTE, end: T0 + 30 * MINUTE + 30 * SECOND }],
      noRounding,
    );
    expect(result).toMatchObject({
      kind: 'entries',
      segments: [seg(0, 10)],
      trackedMs: 10.5 * MINUTE,
      roundedMs: 10 * MINUTE,
    });
  });

  it('discards when only isolated short segments remain', () => {
    const isolated = [
      { start: T0, end: T0 + 40 * SECOND },
      { start: T0 + 30 * MINUTE, end: T0 + 30 * MINUTE + 40 * SECOND },
    ];
    expect(prepareEntries(isolated, noRounding)).toMatchObject({ kind: 'discard', reason: 'belowMinimum' });
  });

  it('does not mutate the input', () => {
    const input = [seg(0, 10), seg(20, 33)];
    const copy = structuredClone(input);
    prepareEntries(input, fiveMinutes);
    expect(input).toEqual(copy);
  });
});
