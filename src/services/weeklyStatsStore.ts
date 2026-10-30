import { validateStats } from '../core/validation';
import {
  addLoggedEntries,
  markSummaryShown,
  pendingWeeklySummary,
  type LoggedEntry,
  type WeeklySummary,
} from '../core/weeklyStats';
import type { StatsFile } from '../types/stats';
import { SerialQueue } from '../util/serialQueue';
import type { Clock } from './rateLimiter';
import { JsonFileStore } from './storageService';

export interface WeeklyStatsStoreOptions {
  directory: string;
  clock?: Clock;
}

/** Time logged per week (`stats.json`), shared by every window, for the weekly summary. */
export class WeeklyStatsStore {
  private readonly store: JsonFileStore<StatsFile>;
  private readonly clock: Clock;
  private readonly serial = new SerialQueue();

  constructor(options: WeeklyStatsStoreOptions) {
    this.store = new JsonFileStore(options.directory, 'stats.json', { validate: validateStats });
    this.clock = options.clock ?? Date.now;
  }

  async record(entries: readonly LoggedEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    await this.serial.run(() =>
      this.store.update((current) => addLoggedEntries(current, entries, this.clock())),
    );
  }

  /** Last week's summary if it is due, marking it as shown so no window shows it again. */
  async takeSummary(): Promise<WeeklySummary | undefined> {
    return this.serial.run(async () => {
      const now = this.clock();
      const current = await this.store.read();
      const summary = pendingWeeklySummary(current, now);
      if (summary !== undefined) {
        await this.store.write(markSummaryShown(current, summary.weekKey, now));
      }
      return summary;
    });
  }
}
