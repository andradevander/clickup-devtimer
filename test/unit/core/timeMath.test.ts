import { describe, expect, it } from 'vitest';
import { formatDuration } from '../../../src/core/timeMath';

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
