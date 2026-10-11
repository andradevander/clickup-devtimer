import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_STREAK_GAP_MS,
  MANUAL_PAUSE_PROMPT_AFTER_MS,
  hasDayRolledOver,
  isIdle,
  isLongSessionWarningDue,
  isRepeatingWarningDue,
  shouldPromptManualPauseResume,
  updateActivityStreak,
  type ActivityStreak,
} from '../../../src/core/idlePolicy';
import { HOUR, MINUTE, SECOND, T0 } from './fixtures';

describe('isIdle', () => {
  it('is idle only after the threshold is exceeded', () => {
    expect(isIdle(T0 + 2 * MINUTE, T0, 2 * MINUTE)).toBe(false);
    expect(isIdle(T0 + 2 * MINUTE + 1, T0, 2 * MINUTE)).toBe(true);
  });
});

describe('activity streak', () => {
  it('starts a streak on the first event', () => {
    expect(updateActivityStreak(null, T0)).toEqual({ startedAt: T0, lastEventAt: T0 });
  });

  it('extends a streak while events are close together', () => {
    const streak = updateActivityStreak({ startedAt: T0, lastEventAt: T0 }, T0 + 10 * SECOND);
    expect(streak).toEqual({ startedAt: T0, lastEventAt: T0 + 10 * SECOND });
  });

  it('restarts the streak after a gap', () => {
    const at = T0 + ACTIVITY_STREAK_GAP_MS + 1;
    expect(updateActivityStreak({ startedAt: T0, lastEventAt: T0 }, at)).toEqual({
      startedAt: at,
      lastEventAt: at,
    });
  });

  it('ignores out-of-order events', () => {
    const streak = updateActivityStreak({ startedAt: T0, lastEventAt: T0 + 10 * SECOND }, T0 + 5 * SECOND);
    expect(streak.lastEventAt).toBe(T0 + 10 * SECOND);
  });
});

describe('shouldPromptManualPauseResume', () => {
  const longStreak: ActivityStreak = { startedAt: T0, lastEventAt: T0 + MANUAL_PAUSE_PROMPT_AFTER_MS };
  const now = T0 + MANUAL_PAUSE_PROMPT_AFTER_MS + SECOND;

  it('prompts after continuous activity', () => {
    expect(shouldPromptManualPauseResume(longStreak, now, null)).toBe(true);
  });

  it('does not prompt for short bursts', () => {
    expect(
      shouldPromptManualPauseResume({ startedAt: T0, lastEventAt: T0 + 30 * SECOND }, T0 + 31 * SECOND, null),
    ).toBe(false);
    expect(shouldPromptManualPauseResume(null, now, null)).toBe(false);
  });

  it('does not prompt once the streak went quiet', () => {
    expect(
      shouldPromptManualPauseResume(longStreak, longStreak.lastEventAt + ACTIVITY_STREAK_GAP_MS + 1, null),
    ).toBe(false);
  });

  it('respects the snooze', () => {
    expect(shouldPromptManualPauseResume(longStreak, now, now + MINUTE)).toBe(false);
    expect(shouldPromptManualPauseResume(longStreak, now, now)).toBe(true);
  });
});

describe('isRepeatingWarningDue', () => {
  it('is due after the interval and then every interval', () => {
    expect(isRepeatingWarningDue(T0, T0 + 59 * MINUTE, null, HOUR)).toBe(false);
    expect(isRepeatingWarningDue(T0, T0 + HOUR, null, HOUR)).toBe(true);
    expect(isRepeatingWarningDue(T0, T0 + 90 * MINUTE, T0 + HOUR, HOUR)).toBe(false);
    expect(isRepeatingWarningDue(T0, T0 + 2 * HOUR, T0 + HOUR, HOUR)).toBe(true);
  });

  it('is never due when disabled', () => {
    expect(isRepeatingWarningDue(T0, T0 + 10 * HOUR, null, 0)).toBe(false);
  });
});

describe('isLongSessionWarningDue', () => {
  it('warns once per threshold crossed', () => {
    expect(isLongSessionWarningDue(3 * HOUR, 4 * HOUR, 0)).toBe(false);
    expect(isLongSessionWarningDue(4 * HOUR, 4 * HOUR, 0)).toBe(true);
    expect(isLongSessionWarningDue(5 * HOUR, 4 * HOUR, 1)).toBe(false);
    expect(isLongSessionWarningDue(8 * HOUR, 4 * HOUR, 1)).toBe(true);
  });

  it('is never due when disabled', () => {
    expect(isLongSessionWarningDue(100 * HOUR, 0, 0)).toBe(false);
  });
});

describe('hasDayRolledOver', () => {
  const lateNight = new Date(2026, 0, 15, 23, 30).getTime();

  it('detects crossing midnight', () => {
    expect(hasDayRolledOver(lateNight, new Date(2026, 0, 16, 0, 5).getTime())).toBe(true);
  });

  it('is false on the same day or when the clock went back', () => {
    expect(hasDayRolledOver(T0, T0 + HOUR)).toBe(false);
    expect(hasDayRolledOver(lateNight, new Date(2026, 0, 14, 10).getTime())).toBe(false);
  });
});
