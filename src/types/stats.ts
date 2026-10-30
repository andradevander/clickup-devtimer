/** Time logged in one local week (Monday to Sunday). */
export interface WeekTally {
  /** Total duration of the entries logged, in milliseconds. */
  totalMs: number;
  /** Distinct tasks the time was logged on. */
  taskIds: string[];
  /** The weekly summary of this week was already shown (by any window). */
  summaryShown: boolean;
}

/** Contents of `stats.json`: the current and previous week, keyed by their Monday (`YYYY-MM-DD`). */
export interface StatsFile {
  schemaVersion: 1;
  weeks: Record<string, WeekTally>;
}
