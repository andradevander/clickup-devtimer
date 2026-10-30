import { describe, expect, it, vi } from 'vitest';
import { ClickUpApiError } from '../../../src/services/clickupService';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  LEASE_MS,
  SyncQueue,
  backoffMs,
  type NewQueueItem,
  type SyncClient,
} from '../../../src/services/syncQueue';
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

function setup(options: { noDescriptionTeams?: Iterable<string> } = {}) {
  const clock = fakeClock(T0);
  const client = {
    createTimeEntry: vi.fn<SyncClient['createTimeEntry']>().mockResolvedValue('entry-id'),
    getTimeEntries: vi.fn<SyncClient['getTimeEntries']>().mockResolvedValue([]),
  };
  const queue = new SyncQueue({
    directory: dir.path,
    client,
    clock: clock.now,
    newId: sequentialIds('q'),
    ...options,
  });
  return { clock, client, queue };
}

const apiError = (kind: ConstructorParameters<typeof ClickUpApiError>[0], retryAfterMs?: number) =>
  new ClickUpApiError(kind, `${kind} error`, undefined, undefined, retryAfterMs);

const ADVANCED_LIMIT_MESSAGE =
  'POST /team/9000/time_entries failed with 403: Your plan is limited to 40 usages of Advanced Time Tracking, 40 usage.';
const BASIC_LIMIT_MESSAGE =
  'POST /team/9000/time_entries failed with 403: Your plan is limited to 100 usages of Time Tracking, 100 usage.';
const planLimitError = (message: string) => new ClickUpApiError('forbidden', message, 403);

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
        leaseUntil: 0,
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

    expect(await queue.process()).toEqual({
      synced: 2,
      failed: 0,
      remaining: 0,
      authError: false,
      descriptionsDropped: 0,
      planLimitReached: false,
      learnedNoDescriptionTeams: [],
    });
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

    expect(await queue.process()).toEqual({
      synced: 1,
      failed: 0,
      remaining: 1,
      authError: false,
      descriptionsDropped: 0,
      planLimitReached: false,
      learnedNoDescriptionTeams: [],
    });
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

    expect(await queue.process()).toEqual({
      synced: 0,
      failed: 0,
      remaining: 2,
      authError: true,
      descriptionsDropped: 0,
      planLimitReached: false,
      learnedNoDescriptionTeams: [],
    });
    expect((await queue.items()).map((item) => item.attempts)).toEqual([0, 0]);
  });

  it.each(['client', 'forbidden', 'notFound'] as const)('marks the item as failed on %s', async (kind) => {
    const { queue, client } = setup();
    await queue.enqueue([entry(T0), entry(T0 + 20 * MINUTE)]);
    client.createTimeEntry.mockRejectedValueOnce(apiError(kind));

    expect(await queue.process()).toEqual({
      synced: 1,
      failed: 1,
      remaining: 1,
      authError: false,
      descriptionsDropped: 0,
      planLimitReached: false,
      learnedNoDescriptionTeams: [],
    });
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

  it('skips items leased by another window until the lease expires', async () => {
    const { queue, client, clock } = setup();
    await queue.enqueue([entry(T0)]);
    const path = join(dir.path, 'queue.json');
    const file = JSON.parse(await readFile(path, 'utf8')) as { items: { leaseUntil: number }[] };
    const leased = { ...file, items: file.items.map((item) => ({ ...item, leaseUntil: T0 + LEASE_MS })) };
    await writeFile(path, JSON.stringify(leased), 'utf8');

    expect(await queue.process()).toMatchObject({ synced: 0, remaining: 1 });
    expect(client.createTimeEntry).not.toHaveBeenCalled();

    clock.advance(LEASE_MS);
    expect(await queue.process()).toMatchObject({ synced: 1, remaining: 0 });
  });

  it('skips an item another window sent while this run was in progress', async () => {
    const { queue, client } = setup();
    const otherWindow = new SyncQueue({ directory: dir.path, client, newId: () => 'other' });
    const [first, second] = await queue.enqueue([entry(T0), entry(T0 + 20 * MINUTE)]);
    client.createTimeEntry.mockImplementationOnce(async () => {
      // While the first item is being sent, another window removes the second one.
      await otherWindow.discard(second?.id ?? '');
      return 'entry-id';
    });
    expect(await queue.process()).toMatchObject({ synced: 1, remaining: 0 });
    expect(client.createTimeEntry).toHaveBeenCalledTimes(1);
    expect(first).toBeDefined();
  });

  it('releases the lease when stopped by an auth error', async () => {
    const { queue, client } = setup();
    await queue.enqueue([entry(T0)]);
    client.createTimeEntry.mockRejectedValueOnce(apiError('unauthorized'));
    await queue.process();
    expect((await queue.items())[0]?.leaseUntil).toBe(0);
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
  describe('ClickUp plan limits', () => {
    const withoutDescription = (start: number) => ({ tid: 'abc123xyz', start, duration: 10 * MINUTE });

    it('resends an entry without its description when the advanced limit is hit', async () => {
      const { queue, client } = setup();
      await queue.enqueue([entry(T0)]);
      client.createTimeEntry.mockRejectedValueOnce(planLimitError(ADVANCED_LIMIT_MESSAGE));

      expect(await queue.process()).toEqual({
        synced: 1,
        failed: 0,
        remaining: 0,
        authError: false,
        descriptionsDropped: 1,
        planLimitReached: false,
        learnedNoDescriptionTeams: ['9000'],
      });
      expect(client.createTimeEntry).toHaveBeenCalledTimes(2);
      expect(client.createTimeEntry).toHaveBeenNthCalledWith(1, '9000', {
        ...withoutDescription(T0),
        description: 'feature/CU-abc123xyz',
      });
      expect(client.createTimeEntry).toHaveBeenNthCalledWith(2, '9000', withoutDescription(T0));
      expect(await queue.items()).toEqual([]);
    });

    it('sends later entries of the same workspace without a description right away', async () => {
      const { queue, client } = setup();
      await queue.enqueue([entry(T0), entry(T0 + 20 * MINUTE)]);
      client.createTimeEntry.mockRejectedValueOnce(planLimitError(ADVANCED_LIMIT_MESSAGE));
      expect(await queue.process()).toMatchObject({ synced: 2, descriptionsDropped: 2 });
      expect(client.createTimeEntry).toHaveBeenCalledTimes(3);
      expect(client.createTimeEntry).toHaveBeenLastCalledWith('9000', withoutDescription(T0 + 20 * MINUTE));

      // Also in later runs.
      client.createTimeEntry.mockClear();
      await queue.enqueue([entry(T0 + 40 * MINUTE)]);
      expect(await queue.process()).toMatchObject({ synced: 1, descriptionsDropped: 1 });
      expect(client.createTimeEntry).toHaveBeenCalledTimes(1);
      expect(client.createTimeEntry).toHaveBeenCalledWith('9000', withoutDescription(T0 + 40 * MINUTE));
    });

    it('keeps sending descriptions to other workspaces', async () => {
      const { queue, client } = setup();
      await queue.enqueue([entry(T0), entry(T0 + 20 * MINUTE, { teamId: '7000' })]);
      client.createTimeEntry.mockRejectedValueOnce(planLimitError(ADVANCED_LIMIT_MESSAGE));
      expect(await queue.process()).toMatchObject({ synced: 2, descriptionsDropped: 1 });
      expect(client.createTimeEntry).toHaveBeenLastCalledWith('7000', {
        ...withoutDescription(T0 + 20 * MINUTE),
        description: 'feature/CU-abc123xyz',
      });
    });

    it('does not count entries without a description as dropped', async () => {
      const { queue, client } = setup();
      await queue.enqueue([entry(T0), entry(T0 + 20 * MINUTE, { description: '' })]);
      client.createTimeEntry.mockRejectedValueOnce(planLimitError(ADVANCED_LIMIT_MESSAGE));
      expect(await queue.process()).toMatchObject({ synced: 2, descriptionsDropped: 1 });
    });

    it('re-sends entries that previously failed because of the advanced limit', async () => {
      const { queue, client } = setup();
      await queue.enqueue([entry(T0), entry(T0 + 20 * MINUTE), entry(T0 + 40 * MINUTE)]);
      const path = join(dir.path, 'queue.json');
      const file = JSON.parse(await readFile(path, 'utf8')) as { items: Record<string, unknown>[] };
      const stuck = {
        ...file,
        items: file.items.map((item, index) =>
          index === 2
            ? {
                ...item,
                status: 'failed',
                attempts: 1,
                lastError: { kind: 'client', message: 'Bad request' },
              }
            : {
                ...item,
                status: 'failed',
                attempts: 1,
                lastError: { kind: 'forbidden', message: ADVANCED_LIMIT_MESSAGE },
              },
        ),
      };
      await writeFile(path, JSON.stringify(stuck), 'utf8');

      // The workspace is not known to reject descriptions yet: the first one is tried with it.
      client.createTimeEntry.mockRejectedValueOnce(planLimitError(ADVANCED_LIMIT_MESSAGE));
      expect(await queue.process()).toMatchObject({
        synced: 2,
        failed: 0,
        remaining: 1,
        descriptionsDropped: 2,
      });
      expect(client.createTimeEntry).toHaveBeenCalledTimes(3);
      // Other permanent failures stay failed.
      expect(await queue.items()).toMatchObject([{ status: 'failed', lastError: { kind: 'client' } }]);
    });

    it('stops the run when the time tracking limit of the plan is reached', async () => {
      const { queue, client } = setup();
      await queue.enqueue([entry(T0), entry(T0 + 20 * MINUTE)]);
      client.createTimeEntry.mockRejectedValue(planLimitError(BASIC_LIMIT_MESSAGE));

      expect(await queue.process()).toEqual({
        synced: 0,
        failed: 1,
        remaining: 2,
        authError: false,
        descriptionsDropped: 0,
        planLimitReached: true,
        learnedNoDescriptionTeams: [],
      });
      expect(client.createTimeEntry).toHaveBeenCalledTimes(1);
      expect(await queue.items()).toMatchObject([
        { status: 'failed', attempts: 1, lastError: { kind: 'forbidden', message: BASIC_LIMIT_MESSAGE } },
        { status: 'pending', attempts: 0 },
      ]);

      // Later runs leave the workspace alone instead of using up a request per run, but still
      // report why its entries are waiting...
      client.createTimeEntry.mockClear();
      expect(await queue.process()).toMatchObject({
        synced: 0,
        failed: 0,
        remaining: 2,
        planLimitReached: true,
      });
      expect(client.createTimeEntry).not.toHaveBeenCalled();

      // ...until the user asks to retry.
      client.createTimeEntry.mockResolvedValue('entry-id');
      await queue.retryAll();
      expect(await queue.process()).toMatchObject({ synced: 2, remaining: 0 });
    });

    it('keeps sending to other workspaces after one reaches the plan limit', async () => {
      const { queue, client } = setup();
      await queue.enqueue([entry(T0), entry(T0 + 20 * MINUTE)]);
      client.createTimeEntry.mockRejectedValueOnce(planLimitError(BASIC_LIMIT_MESSAGE));
      await queue.process();

      await queue.enqueue([entry(T0 + 40 * MINUTE, { teamId: '7000' })]);
      client.createTimeEntry.mockClear();
      expect(await queue.process()).toMatchObject({ synced: 1, remaining: 2 });
      expect(client.createTimeEntry).toHaveBeenCalledWith('7000', expect.anything());

      // Retrying a single entry also lifts the pause for its workspace.
      const [failedItem] = await queue.items();
      await queue.retry(failedItem?.id ?? '');
      expect(await queue.process()).toMatchObject({ synced: 2, remaining: 0 });
    });

    it('stops the run when an entry hits the advanced limit even without its description', async () => {
      const { queue, client } = setup();
      await queue.enqueue([entry(T0), entry(T0 + 20 * MINUTE)]);
      client.createTimeEntry.mockRejectedValue(planLimitError(ADVANCED_LIMIT_MESSAGE));

      expect(await queue.process()).toMatchObject({
        synced: 0,
        failed: 1,
        remaining: 2,
        planLimitReached: true,
      });
      // With the description, then without it; the second entry is not tried.
      expect(client.createTimeEntry).toHaveBeenCalledTimes(2);
      expect(await queue.items()).toMatchObject([{ status: 'failed' }, { status: 'pending' }]);
    });

    it('reports a workspace as newly learned only once', async () => {
      const { queue, client } = setup();
      await queue.enqueue([entry(T0), entry(T0 + 20 * MINUTE)]);
      client.createTimeEntry.mockRejectedValueOnce(planLimitError(ADVANCED_LIMIT_MESSAGE));
      expect(await queue.process()).toMatchObject({ learnedNoDescriptionTeams: ['9000'] });

      await queue.enqueue([entry(T0 + 40 * MINUTE)]);
      expect(await queue.process()).toMatchObject({ descriptionsDropped: 1, learnedNoDescriptionTeams: [] });
    });

    it('starts from the workspaces already known to reject descriptions', async () => {
      const { queue, client } = setup({ noDescriptionTeams: ['9000'] });
      await queue.enqueue([entry(T0), entry(T0 + 20 * MINUTE, { teamId: '7000' })]);

      expect(await queue.process()).toMatchObject({
        synced: 2,
        descriptionsDropped: 1,
        learnedNoDescriptionTeams: [],
      });
      expect(client.createTimeEntry).toHaveBeenCalledTimes(2);
      expect(client.createTimeEntry).toHaveBeenNthCalledWith(1, '9000', withoutDescription(T0));
      expect(client.createTimeEntry).toHaveBeenNthCalledWith(2, '7000', {
        ...withoutDescription(T0 + 20 * MINUTE),
        description: 'feature/CU-abc123xyz',
      });
    });

    it('tries descriptions again after the known workspaces are reset', async () => {
      const { queue, client } = setup({ noDescriptionTeams: ['9000'] });
      queue.resetNoDescriptionTeams();
      await queue.enqueue([entry(T0)]);

      expect(await queue.process()).toMatchObject({ synced: 1, descriptionsDropped: 0 });
      expect(client.createTimeEntry).toHaveBeenCalledWith('9000', {
        ...withoutDescription(T0),
        description: 'feature/CU-abc123xyz',
      });

      // If the plan still rejects them, the workspace is learned again.
      client.createTimeEntry.mockRejectedValueOnce(planLimitError(ADVANCED_LIMIT_MESSAGE));
      await queue.enqueue([entry(T0 + 20 * MINUTE)]);
      expect(await queue.process()).toMatchObject({ synced: 1, learnedNoDescriptionTeams: ['9000'] });
    });

    it('sends the entry the user retried first', async () => {
      const { queue, client } = setup();
      const [, second, third] = await queue.enqueue([
        entry(T0),
        entry(T0 + 20 * MINUTE),
        entry(T0 + 40 * MINUTE),
      ]);
      client.createTimeEntry.mockRejectedValueOnce(planLimitError(BASIC_LIMIT_MESSAGE));
      await queue.process();

      // The plan still refuses the second entry, but the one the user picked goes through.
      client.createTimeEntry.mockClear();
      client.createTimeEntry.mockImplementation((_teamId, timeEntry) =>
        timeEntry.start === second?.start
          ? Promise.reject(planLimitError(BASIC_LIMIT_MESSAGE))
          : Promise.resolve('entry-id'),
      );
      await queue.retry(third?.id ?? '');
      expect(await queue.process()).toMatchObject({ synced: 1, failed: 1, planLimitReached: true });
      expect(client.createTimeEntry).toHaveBeenNthCalledWith(
        1,
        '9000',
        expect.objectContaining({ start: T0 + 40 * MINUTE }),
      );
    });

    it('still checks for duplicates before resending without a description', async () => {
      const { queue, client, clock } = setup();
      await queue.enqueue([entry(T0)]);
      client.createTimeEntry.mockRejectedValueOnce(apiError('timeout'));
      await queue.process();
      client.createTimeEntry.mockClear();
      client.createTimeEntry.mockRejectedValueOnce(planLimitError(ADVANCED_LIMIT_MESSAGE));
      clock.advance(MINUTE);

      expect(await queue.process()).toMatchObject({ synced: 1, descriptionsDropped: 1 });
      expect(client.getTimeEntries).toHaveBeenCalledTimes(1);
      expect(client.createTimeEntry).toHaveBeenCalledTimes(2);
    });
  });
});
