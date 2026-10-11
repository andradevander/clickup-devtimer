import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { WindowCoordinator, type WindowCoordinatorOptions } from '../../../src/services/windowCoordinator';
import { fakeClock, useTempDirectory } from '../helpers';

const T0 = 1_760_000_000_000;
const dir = useTempDirectory();

function setup() {
  const clock = fakeClock(T0);
  const alive = new Set<number>([1, 2, 3]);
  const create = (windowId: string, pid: number, overrides: Partial<WindowCoordinatorOptions> = {}) =>
    new WindowCoordinator({
      directory: dir.path,
      windowId,
      pid,
      clock: clock.now,
      sleep: () => Promise.resolve(),
      isProcessAlive: (p) => alive.has(p),
      ...overrides,
    });
  return { clock, alive, create };
}

async function readJson(name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(dir.path, name), 'utf8'));
}

describe('WindowCoordinator ownership', () => {
  it('acquires a free lock', async () => {
    const { create } = setup();
    const a = create('a', 1);
    const changes: boolean[] = [];
    a.onDidChangeOwnership((owner) => changes.push(owner));

    await a.tick();

    expect(a.isOwner).toBe(true);
    expect(changes).toEqual([true]);
    expect(await readJson('lock.json')).toEqual({ schemaVersion: 1, windowId: 'a', pid: 1, heartbeatAt: T0 });
  });

  it('does not take a live lock from another window', async () => {
    const { create } = setup();
    const a = create('a', 1);
    const b = create('b', 2);
    await a.tick();
    await b.tick();
    expect(a.isOwner).toBe(true);
    expect(b.isOwner).toBe(false);
    expect(await b.isLockedByAnotherWindow()).toBe(true);
    expect(await a.isLockedByAnotherWindow()).toBe(false);
  });

  it('renews the heartbeat while owning', async () => {
    const { create, clock } = setup();
    const a = create('a', 1);
    await a.tick();
    clock.advance(5_000);
    await a.tick();
    expect(await readJson('lock.json')).toMatchObject({ heartbeatAt: T0 + 5_000 });
  });

  it('takes over a lock whose heartbeat is stale', async () => {
    const { create, clock } = setup();
    const a = create('a', 1);
    const b = create('b', 2);
    await a.tick();
    clock.advance(30_001);
    await b.tick();
    expect(b.isOwner).toBe(true);

    // The previous owner steps down on its next tick.
    await a.tick();
    expect(a.isOwner).toBe(false);
  });

  it('takes over right away when the owner process is gone', async () => {
    const { create, alive } = setup();
    const a = create('a', 1);
    const b = create('b', 2);
    await a.tick();
    alive.delete(1);
    await b.tick();
    expect(b.isOwner).toBe(true);
    expect(await b.isLockedByAnotherWindow()).toBe(false);
  });

  it('claims the lock on demand', async () => {
    const { create } = setup();
    const a = create('a', 1);
    const b = create('b', 2);
    await a.tick();
    await b.claim();
    await a.tick();
    expect(b.isOwner).toBe(true);
    expect(a.isOwner).toBe(false);
  });

  it('lets the last writer win when two windows race for the lock', async () => {
    const { create } = setup();
    const b = create('b', 2);
    // While "a" waits to verify its write, "b" writes the lock too.
    const a = create('a', 1, { sleep: () => b.claim() });
    await a.tick();
    expect(a.isOwner).toBe(false);
    expect(b.isOwner).toBe(true);
  });

  it('reports heartbeat loop errors instead of throwing', async () => {
    const { create } = setup();
    // A file where the storage directory should be makes every read fail.
    const blocked = join(dir.path, 'not-a-directory');
    await writeFile(blocked, '', 'utf8');
    const onError = vi.fn();
    const a = create('a', 1, { directory: blocked, onError, heartbeatIntervalMs: 60_000 });
    a.start();
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalled();
    });
    a.dispose();
  });

  it('treats a corrupt lock as free', async () => {
    const { create } = setup();
    await writeFile(join(dir.path, 'lock.json'), 'garbage', 'utf8');
    const a = create('a', 1);
    await a.tick();
    expect(a.isOwner).toBe(true);
  });

  it('releases the lock on shutdown', async () => {
    const { create } = setup();
    const a = create('a', 1);
    const b = create('b', 2);
    await a.tick();
    await a.shutdown();
    expect(a.isOwner).toBe(false);
    expect(await b.isLockedByAnotherWindow()).toBe(false);
  });

  it('keeps the owner lock when a non-owner shuts down', async () => {
    const { create } = setup();
    const a = create('a', 1);
    const b = create('b', 2);
    await a.tick();
    await b.tick();
    await b.shutdown();
    expect(await readJson('lock.json')).toMatchObject({ windowId: 'a' });
  });

  it('runs the heartbeat loop until shutdown', async () => {
    const { create } = setup();
    const a = create('a', 1, { heartbeatIntervalMs: 10 });
    a.start();
    await vi.waitFor(() => {
      expect(a.isOwner).toBe(true);
    });
    await a.shutdown();
    a.dispose();
  });
});

describe('WindowCoordinator activity', () => {
  it('writes activity and reports the latest across windows', async () => {
    const { create, clock } = setup();
    const a = create('a', 1);
    const b = create('b', 2);
    await a.reportActivity(T0);
    clock.advance(1_000);
    await b.reportActivity(T0 + 1_000);

    expect(await readJson('activity.json')).toEqual({ schemaVersion: 1, windows: { a: T0, b: T0 + 1_000 } });
    expect(await a.latestActivity()).toBe(T0 + 1_000);
  });

  it('returns undefined when there is no activity', async () => {
    const { create } = setup();
    expect(await create('a', 1).latestActivity()).toBeUndefined();
  });

  it('throttles writes but keeps the latest value in memory and flushes it on tick', async () => {
    const { create, clock } = setup();
    const a = create('a', 1);
    const b = create('b', 2);
    await a.reportActivity(T0);
    clock.advance(1_000);
    await a.reportActivity(T0 + 1_000);

    expect(await readJson('activity.json')).toEqual({ schemaVersion: 1, windows: { a: T0 } });
    expect(await a.latestActivity()).toBe(T0 + 1_000);
    expect(await b.latestActivity()).toBe(T0);

    await a.tick();
    expect(await b.latestActivity()).toBe(T0 + 1_000);
  });

  it('writes again once the throttle interval passed', async () => {
    const { create, clock } = setup();
    const a = create('a', 1);
    await a.reportActivity(T0);
    clock.advance(5_000);
    await a.reportActivity(T0 + 5_000);
    expect(await readJson('activity.json')).toEqual({ schemaVersion: 1, windows: { a: T0 + 5_000 } });
  });

  it('prunes activity from windows gone for more than a day', async () => {
    const { create, clock } = setup();
    await create('old', 3).reportActivity(T0);
    clock.advance(24 * 60 * 60 * 1000 + 1);
    await create('a', 1).reportActivity(clock.now());
    expect(await readJson('activity.json')).toEqual({ schemaVersion: 1, windows: { a: clock.now() } });
  });

  it('removes its activity on shutdown', async () => {
    const { create } = setup();
    const a = create('a', 1);
    const b = create('b', 2);
    await a.reportActivity(T0);
    await b.reportActivity(T0);
    await a.shutdown();
    expect(await readJson('activity.json')).toEqual({ schemaVersion: 1, windows: { b: T0 } });
  });

  it('uses a random window ID and the real process by default', async () => {
    const coordinator = new WindowCoordinator({ directory: dir.path, sleep: () => Promise.resolve() });
    expect(coordinator.windowId).toMatch(/^[0-9a-f-]{36}$/);
    await coordinator.tick();
    expect(await readJson('lock.json')).toMatchObject({ pid: process.pid });

    // The current process is alive, so another window does not take the lock over.
    const other = new WindowCoordinator({ directory: dir.path, sleep: () => Promise.resolve() });
    await other.tick();
    expect(other.isOwner).toBe(false);
    coordinator.dispose();
    other.dispose();
  });

  it('treats a lock from a process that no longer exists as abandoned', async () => {
    const stale = { schemaVersion: 1, windowId: 'ghost', pid: 2 ** 22 + 12345, heartbeatAt: Date.now() };
    await writeFile(join(dir.path, 'lock.json'), JSON.stringify(stale), 'utf8');
    const coordinator = new WindowCoordinator({ directory: dir.path, sleep: () => Promise.resolve() });
    await coordinator.tick();
    expect(coordinator.isOwner).toBe(true);
    coordinator.dispose();
  });
});
