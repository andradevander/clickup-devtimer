import type { TaskRef } from '../../../src/types/session';

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

/** Fixed base timestamp for tests: 2026-01-15 09:00 local time. */
export const T0 = new Date(2026, 0, 15, 9, 0, 0).getTime();

export const task: TaskRef = {
  id: 'abc123xyz',
  name: 'Fictional task',
  url: 'https://app.clickup.com/t/abc123xyz',
  listId: '900100',
  teamId: '9000',
};
