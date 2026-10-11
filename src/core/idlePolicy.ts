import { isSameLocalDay, secondsToMs } from './timeMath';

/** Activity events further apart than this break a continuous activity streak. */
export const ACTIVITY_STREAK_GAP_MS = secondsToMs(15);

/** Continuous activity needed during a manual pause before asking "are you still on a break?". */
export const MANUAL_PAUSE_PROMPT_AFTER_MS = secondsToMs(60);

/** How long "keep paused" silences the manual-pause prompt. */
export const MANUAL_PAUSE_SNOOZE_MS = secondsToMs(15 * 60);

export function isIdle(now: number, lastActivityTime: number, thresholdMs: number): boolean {
  return now - lastActivityTime > thresholdMs;
}

export interface ActivityStreak {
  startedAt: number;
  lastEventAt: number;
}

export function updateActivityStreak(streak: ActivityStreak | null, at: number): ActivityStreak {
  if (streak === null || at - streak.lastEventAt > ACTIVITY_STREAK_GAP_MS) {
    return { startedAt: at, lastEventAt: at };
  }
  return { startedAt: streak.startedAt, lastEventAt: Math.max(streak.lastEventAt, at) };
}

/**
 * Whether to ask the user if they are still on a break, after continuous activity was detected
 * during a manual pause (spec §3.5).
 */
export function shouldPromptManualPauseResume(
  streak: ActivityStreak | null,
  now: number,
  snoozedUntil: number | null,
): boolean {
  if (streak === null || now - streak.lastEventAt > ACTIVITY_STREAK_GAP_MS) {
    return false;
  }
  if (snoozedUntil !== null && now < snoozedUntil) {
    return false;
  }
  return streak.lastEventAt - streak.startedAt >= MANUAL_PAUSE_PROMPT_AFTER_MS;
}

/** Whether a repeating warning is due: first after `intervalMs` from `since`, then every `intervalMs`. */
export function isRepeatingWarningDue(
  since: number,
  now: number,
  lastWarnedAt: number | null,
  intervalMs: number,
): boolean {
  if (intervalMs <= 0 || now - since < intervalMs) {
    return false;
  }
  return lastWarnedAt === null || now - lastWarnedAt >= intervalMs;
}

/** Whether the elapsed time crossed a new multiple of `thresholdMs` since the last warning. */
export function isLongSessionWarningDue(
  elapsedMs: number,
  thresholdMs: number,
  warningsShown: number,
): boolean {
  if (thresholdMs <= 0) {
    return false;
  }
  return Math.floor(elapsedMs / thresholdMs) > warningsShown;
}

/** Whether a paused session crossed midnight and should be offered for finishing. */
export function hasDayRolledOver(pausedAt: number, now: number): boolean {
  return now > pausedAt && !isSameLocalDay(pausedAt, now);
}
