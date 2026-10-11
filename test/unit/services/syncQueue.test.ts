import { describe, expect, it, vi } from 'vitest';
import { ClickUpApiError } from '../../../src/services/clickupService';
import { SyncQueue, backoffMs, type NewQueueItem, type SyncClient } from '../../../src/services/syncQueue';
import type { ClickUpTimeEntry } from '../../../src/types/clickup';
import { fakeClock, sequentialIds, useTempDirectory } from '../helpers';

const T0 = 1_760_000_000_000;
const MINUTE = 60_000;
const dir = useTempDirectory();

function entry(start: number, overrides: Partial<NewQueueItem> = {}): NewQueueItem {
  return {
    sessionId: 'session-1',
    teamId: '9000',
    taskId: 'abc123xyz',
    taskName: 'Fictional task',
    start,
    duration: 10 * MINUTE,
    description: 'feature/CU-abc123xyz',
    ...overrides,
  };
}

function setup() {
  const clock = fakeClock(T0);
  const client = {
    createTimeEntry: vi.fn<SyncClient['createTimeEntry']>().mockResolvedValue('entry-id'),
    getTimeEntries: vi.fn<SyncClient['getTimeEntries']>().mockResolvedValue([]),
  };
  const queue = new SyncQueue({ directory: dir.path, client, clock: clock.now, newId: sequentialIds('q') });
  return { clock, client, queue };
}

const apiError = (kind: ConstructorParameters<typeof ClickUpApiError>[0], retryAfterMs?: number) =>
  new ClickUpApiError(kind, `${kind} error`, undefined, undefined, retryAfterMs);

describe('backoffMs', () => {
  it.each([
    [0, 1],
    [1, 1],
    [2, 2],
    [3, 4],
    [6, 32],
    [7, 60],
    [20, 60],
  ])('attempt %i waits %i min', (attempts, minutes) => {
    expect(backoffMs(attempts)).toBe(minutes * MINUTE);
  });
});

describe('SyncQueue', () => {
  it('starts empty', async () => {
    const { queue } = setup();
    expect(await queue.items()).toEqual([]);
  });

  it('enqueues items as pending and due now', async () => {
    const { queue } = setup();
    const changed = vi.fn();
    queue.onDidChange(changed);
    const added = await queue.enqueue([entry(T0)]);
    expect(added).toEqual([
      {
        ...entry(T0),
        id: 'q-1',
        status: 'pending',
        attempts: 0,
        nextAttemptAt: T0,
        outcomeUnknown: false,
        lastError: null,
        createdAt: T0,
      },
    ]);
    expect(await queue.items()).toEqual(added);
    expect(await queue.hasSession('session-1')).toBe(true);
    expect(await queue.hasSession('other')).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('sends due items and removes them', async () => {
    const { queue, client } = setup();
    await queue.enqueue([entry(T0), entry(T0 + 20 * MINUTE)]);

    expect(await queue.process()).toEqual({ synced: 2, failed: 0, remaining: 0, authError: false });
    expect(client.createTimeEntry).toHaveBeenNthCalledWith(1, '9000', {
      tid: 'abc123xyz',
      start: T0,
      duration: 10 * MINUTE,
      description: 'feature/CU-abc123xyz',
    });
    expect(await queue.items()).toEqual([]);
  });

  it('skips items that are not due yet', async () => {
    const { queue, client, clock } = setup();
    await queue.enqueue([entry(T0)]);
    client.createTimeEntry.mockRejectedValueOnce(apiError('server'));
    await queue.process();
    client.createTimeEntry.mockClear();

    expect(await queue.process()).toMatchObject({ synced: 0, remaining: 1 });
    expect(client.createTimeEntry).not.toHaveBeenCalled();

    clock.advance(MINUTE);
    expect(await queue.process()).toMatchObject({ synced: 1, remaining: 0 });
  });

  it('backs off on server errors and keeps going with the next items', async () => {
    const { queue, client } = setup();
    await queue.enqueue([entry(T0), entry(T0 + 20 * MINUTE)]);
    client.createTimeEntry.mockRejectedValueOnce(apiError('server'));

    expect(await queue.process()).toEqual({ synced: 1, failed: 0, remaining: 1, authError: false });
    expect(await queue.items()).toMatchObject([
      {
        start: T0,
        status: 'pending',
        attempts: 1,
        nextAttemptAt: T0 + MINUTE,
        outcomeUnknown: false,
        lastError: { kind: 'server', message: 'server error' },
      },
    ]);
  });

  it('stops the run when offline and flags the outcome as unknown', async () => {
    const { queue, client } = setup();
    await queue.enqueue([entry(T0), entry(T0 + 20 * MINUTE)]);
    client.createTimeEntry.mockRejectedValueOnce(apiError('network'));

    expect(await queue.process()).toMatchObject({ synced: 0, remaining: 2 });
    expect(client.createTimeEntry).toHaveBeenCalledTimes(1);
    expect((await queue.items())[0]).toMatchObject({ attempts: 1, outcomeUnknown: true });
  });

  it('checks ClickUp before resending an entry whose outcome is unknown', async () => {
    const { queue, client, clock } = setup();
    await queue.enqueue([entry(T0)]);
    client.createTimeEntry.mockRejectedValueOnce(apiError('timeout'));
    await queue.process();

    const existing: ClickUpTimeEntry = {
      id: 'e1',
      start: String(T0),
      duration: String(10 * MINUTE),
      description: '',
      task: { id: 'abc123xyz' },
    };
    client.getTimeEntries.mockResolvedValueOnce([existing]);
    client.createTimeEntry.mockClear();
    clock.advance(MINUTE);

    expect(await queue.process()).toMatchObject({ synced: 1, remaining: 0 });
    expect(client.getTimeEntries).toHaveBeenCalledWith('9000', {
      taskId: 'abc123xyz',
      startDate: T0 - 1_000,
      endDate: T0 + 10 * MINUTE + 1_000,
    });
    expect(client.createTimeEntry).not.toHaveBeenCalled();
  });

  it('sends the entry when the check finds no match', async () => {
    const { queue, client, clock } = setup();
    await queue.enqueue([entry(T0)]);
    client.createTimeEntry.mockRejectedValueOnce(apiError('timeout'));
    await queue.process();
    client.getTimeEntries.mockResolvedValueOnce([
      { id: 'other', start: String(T0), duration: String(5 * MINUTE), description: '', task: null },
    ]);
    clock.advance(MINUTE);

    expect(await queue.process()).toMatchObject({ synced: 1 });
    expect(client.createTimeEntry).toHaveBeenCalledTimes(2);
  });

  it('waits for the rate limit without counting an attempt', async () => {
    const { queue, client } = setup();
    await queue.enqueue([entry(T0), entry(T0 + 20 * MINUTE)]);
    client.createTimeEntry.mockRejectedValueOnce(apiError('rateLimited', 30_000));

    expect(await queue.process()).toMatchObject({ synced: 0, remaining: 2 });
    expect(client.createTimeEntry).toHaveBeenCalledTimes(1);
    expect((await queue.items())[0]).toMatchObject({ attempts: 0, nextAttemptAt: T0 + 30_000 });
  });

  it('defaults the rate-limit wait to one minute', async () => {
    const { queue, client } = setup();
    await queue.enqueue([entry(T0)]);
    client.createTimeEntry.mockRejectedValueOnce(apiError('rateLimited'));
    await queue.process();
    expect((await queue.items())[0]?.nextAttemptAt).toBe(T0 + MINUTE);
  });

  it.each(['unauthorized', 'noToken'] as const)('stops without changing items on %s', async (kind) => {
    const { queue, client } = setup();
    await queue.enqueue([entry(T0), entry(T0 + 20 * MINUTE)]);
    client.createTimeEntry.mockRejectedValueOnce(apiError(kind));

    expect(await queue.process()).toEqual({ synced: 0, failed: 0, remaining: 2, authError: true });
    expect((await queue.items()).map((item) => item.attempts)).toEqual([0, 0]);
  });

  it.each(['client', 'forbidden', 'notFound'] as const)('marks the item as failed on %s', async (kind) => {
    const { queue, client } = setup();
    await queue.enqueue([entry(T0), entry(T0 + 20 * MINUTE)]);
    client.createTimeEntry.mockRejectedValueOnce(apiError(kind));

    expect(await queue.process()).toEqual({ synced: 1, failed: 1, remaining: 1, authError: false });
    expect(await queue.items()).toMatchObject([{ status: 'failed', attempts: 1, lastError: { kind } }]);

    // Failed items are not retried automatically.
    client.createTimeEntry.mockClear();
    await queue.process();
    expect(client.createTimeEntry).not.toHaveBeenCalled();
  });

  it('treats unexpected errors as network errors', async () => {
    const { queue, client } = setup();
    await queue.enqueue([entry(T0)]);
    client.createTimeEntry.mockRejectedValueOnce(new Error('weird'));
    await queue.process();
    expect((await queue.items())[0]).toMatchObject({ outcomeUnknown: true, lastError: { kind: 'network' } });

    client.createTimeEntry.mockRejectedValueOnce('not an error');
    await queue.retryAll();
    await queue.process();
    expect((await queue.items())[0]?.lastError?.message).toContain('not an error');
  });

  it('retries a failed item on demand', async () => {
    const { queue, client } = setup();
    await queue.enqueue([entry(T0)]);
    client.createTimeEntry.mockRejectedValueOnce(apiError('client'));
    await queue.process();
    const [failed] = await queue.items();

    await queue.retry(failed?.id ?? '');
    expect(await queue.items()).toMatchObject([{ status: 'pending', nextAttemptAt: 0 }]);
    expect(await queue.process()).toMatchObject({ synced: 1, remaining: 0 });
  });

  it('retries everything on demand', async () => {
    const { queue, client } = setup();
    await queue.enqueue([entry(T0), entry(T0 + 20 * MINUTE)]);
    client.createTimeEntry.mockRejectedValue(apiError('server'));
    await queue.process();
    await queue.retryAll();
    expect((await queue.items()).every((item) => item.nextAttemptAt === 0)).toBe(true);
  });

  it('discards an item', async () => {
    const { queue } = setup();
    const [item] = await queue.enqueue([entry(T0), entry(T0 + 20 * MINUTE)]);
    await queue.discard(item?.id ?? '');
    expect((await queue.items()).map((i) => i.start)).toEqual([T0 + 20 * MINUTE]);
  });

  it('shares one run between concurrent calls', async () => {
    const { queue, client } = setup();
    await queue.enqueue([entry(T0)]);
    const [first, second] = await Promise.all([queue.process(), queue.process()]);
    expect(first).toBe(second);
    expect(client.createTimeEntry).toHaveBeenCalledTimes(1);
  });

  it('keeps items enqueued by another window during a run', async () => {
    const { queue, client } = setup();
    const otherWindow = new SyncQueue({ directory: dir.path, client, newId: () => 'other' });
    await queue.enqueue([entry(T0)]);
    client.createTimeEntry.mockImplementationOnce(async () => {
      await otherWindow.enqueue([entry(T0 + 30 * MINUTE)]);
      return 'entry-id';
    });

    await queue.process();
    expect((await queue.items()).map((item) => item.id)).toEqual(['other']);
    otherWindow.dispose();
    queue.dispose();
  });
});
