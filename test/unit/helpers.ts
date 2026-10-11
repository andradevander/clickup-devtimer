import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';

/** Creates a fresh temp directory before each test and removes it afterwards. */
export function useTempDirectory(): { readonly path: string } {
  const holder = { path: '' };
  beforeEach(async () => {
    holder.path = await mkdtemp(join(tmpdir(), 'clickup-devtimer-test-'));
  });
  afterEach(async () => {
    await rm(holder.path, { recursive: true, force: true });
  });
  return holder;
}

/** A controllable clock. */
export function fakeClock(start: number) {
  let now = start;
  return {
    now: () => now,
    set: (value: number) => {
      now = value;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** Sequential IDs: `id-1`, `id-2`... */
export function sequentialIds(prefix = 'id') {
  let next = 0;
  return () => `${prefix}-${String(++next)}`;
}
