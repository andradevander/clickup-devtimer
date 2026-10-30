import { describe, expect, it } from 'vitest';
import { WeeklyStatsStore } from '../../../src/services/weeklyStatsStore';
import { fakeClock, useTempDirectory } from '../helpers';

const HOUR = 3_600_000;
const MONDAY = new Date(2026, 0, 12, 9).getTime();
const NEXT_MONDAY = new Date(2026, 0, 19, 9).getTime();
const dir = useTempDirectory();

function setup() {
  const clock = fakeClock(MONDAY);
  return { clock, store: new WeeklyStatsStore({ directory: dir.path, clock: clock.now }) };
}

describe('WeeklyStatsStore', () => {
  it('has nothing to show without stats', async () => {
    const { store } = setup();
    expect(await store.takeSummary()).toBeUndefined();
  });

  it('shows last week once, shared by every instance', async () => {
    const { store, clock } = setup();
    await store.record([
      { taskId: 'a', start: MONDAY, duration: 2 * HOUR },
      { taskId: 'b', start: MONDAY + 3 * HOUR, duration: HOUR },
    ]);
    expect(await store.takeSummary()).toBeUndefined();

    clock.set(NEXT_MONDAY);
    const otherWindow = new WeeklyStatsStore({ directory: dir.path, clock: clock.now });
    expect(await store.takeSummary()).toEqual({ weekKey: '2026-01-12', totalMs: 3 * HOUR, taskCount: 2 });
    expect(await store.takeSummary()).toBeUndefined();
    expect(await otherWindow.takeSummary()).toBeUndefined();
  });

  it('keeps concurrent records from one instance', async () => {
    const { store, clock } = setup();
    await Promise.all([
      store.record([{ taskId: 'a', start: MONDAY, duration: HOUR }]),
      store.record([{ taskId: 'b', start: MONDAY, duration: HOUR }]),
    ]);
    clock.set(NEXT_MONDAY);
    expect(await store.takeSummary()).toMatchObject({ totalMs: 2 * HOUR, taskCount: 2 });
  });
});
