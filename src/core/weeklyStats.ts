import type { StatsFile, WeekTally } from '../types/stats';
import { localDayKey } from './timeMath';

/** A time entry as logged by the user (before it reaches ClickUp). */
export interface LoggedEntry {
  taskId: string;
  start: number;
  duration: number;
}

export interface WeeklySummary {
  weekKey: string;
  totalMs: number;
  taskCount: number;
}

const EMPTY_TALLY: WeekTally = { totalMs: 0, taskIds: [], summaryShown: false };

/** Monday (local time) of the week containing `timestamp`, as `YYYY-MM-DD`. */
export function localWeekKey(timestamp: number): string {
  const date = new Date(timestamp);
  const daysSinceMonday = (date.getDay() + 6) % 7;
  return localDayKey(
    new Date(date.getFullYear(), date.getMonth(), date.getDate() - daysSinceMonday).getTime(),
  );
}

export function previousWeekKey(timestamp: number): string {
  const date = new Date(timestamp);
  return localWeekKey(new Date(date.getFullYear(), date.getMonth(), date.getDate() - 7, 12).getTime());
}

/** Only the current and previous weeks are kept. */
function keptWeeks(stats: StatsFile | undefined, now: number): Record<string, WeekTally> {
  const kept = new Set([localWeekKey(now), previousWeekKey(now)]);
  return Object.fromEntries(Object.entries(stats?.weeks ?? {}).filter(([week]) => kept.has(week)));
}

/** Adds entries to the tally of the week they started in, dropping weeks no longer needed. */
export function addLoggedEntries(
  stats: StatsFile | undefined,
  entries: readonly LoggedEntry[],
  now: number,
): StatsFile {
  const weeks = keptWeeks(stats, now);
  const kept = new Set([localWeekKey(now), previousWeekKey(now)]);
  for (const entry of entries) {
    const week = localWeekKey(entry.start);
    if (entry.duration <= 0 || !kept.has(week)) {
      continue;
    }
    const tally = weeks[week] ?? EMPTY_TALLY;
    weeks[week] = {
      ...tally,
      totalMs: tally.totalMs + entry.duration,
      taskIds: tally.taskIds.includes(entry.taskId) ? tally.taskIds : [...tally.taskIds, entry.taskId],
    };
  }
  return { schemaVersion: 1, weeks };
}

/** Last week's summary, when it has logged time and was not shown yet. */
export function pendingWeeklySummary(stats: StatsFile | undefined, now: number): WeeklySummary | undefined {
  const weekKey = previousWeekKey(now);
  const tally = stats?.weeks[weekKey];
  if (tally === undefined || tally.summaryShown || tally.totalMs <= 0) {
    return undefined;
  }
  return { weekKey, totalMs: tally.totalMs, taskCount: tally.taskIds.length };
}

export function markSummaryShown(stats: StatsFile | undefined, weekKey: string, now: number): StatsFile {
  const weeks = keptWeeks(stats, now);
  weeks[weekKey] = { ...(weeks[weekKey] ?? EMPTY_TALLY), summaryShown: true };
  return { schemaVersion: 1, weeks };
}
