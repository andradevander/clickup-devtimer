import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { EntryPolicy } from '../../../src/core/rounding';
import { localDayKey } from '../../../src/core/timeMath';
import {
  DAILY_TOTALS_RETENTION_DAYS,
  MAX_RECENT_TASKS,
  SessionActiveError,
  StateManager,
  type SessionQueue,
} from '../../../src/services/stateManager';
import type { NewQueueItem } from '../../../src/services/syncQueue';
import type { TaskRef } from '../../../src/types/session';
import { fakeClock, sequentialIds, useTempDirectory } from '../helpers';

const T0 = 1_760_000_000_000;
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const THRESHOLD = 2 * MINUTE;
const dir = useTempDirectory();

const policy: EntryPolicy = {
  minimumEntrySeconds: 60,
  roundingMinutes: 0,
  roundingMode: 'nearest',
  inactivityThresholdSeconds: 120,
};

function makeTask(id: string): TaskRef {
  return { id, name: `Task ${id}`, url: `https://app.clickup.com/t/${id}`, listId: 'list1', teamId: '9000' };
}

const taskA = makeTask('aaa111');
const taskB = makeTask('bbb222');

function setup() {
  const clock = fakeClock(T0);
  const queued: NewQueueItem[] = [];
  const queue: SessionQueue = {
    enqueue: vi.fn((entries: readonly NewQueueItem[]) => {
      queued.push(...entries);
      return Promise.resolve([]);
    }),
    hasSession: vi.fn((sessionId: string) =>
      Promise.resolve(queued.some((item) => item.sessionId === sessionId)),
    ),
  };
  const create = () =>
    new StateManager({ directory: dir.path, queue, clock: clock.now, newId: sequentialIds('session') });
  return { clock, queued, queue, manager: create(), create };
}

describe('StateManager basics', () => {
  it('starts with an empty state', async () => {
    const { manager } = setup();
    expect(manager.session).toBeNull();
    expect(await manager.refresh()).toEqual({
      schemaVersion: 1,
      session: null,
      recentTasks: [],
      ignoredBranches: [],
      dailyTotals: {},
    });
  });

  it('starts a session, persists it and remembers the task', async () => {
    const { manager, create } = setup();
    const changes = vi.fn();
    manager.onDidChange(changes);

    const session = await manager.start(taskA);

    expect(session).toMatchObject({ id: 'session-1', status: 'running', openSegmentStart: T0, task: taskA });
    expect(manager.session).toEqual(session);
    expect(manager.state.recentTasks).toEqual([taskA]);
    expect(changes).toHaveBeenCalledTimes(1);

    // Another window sees the same state on disk.
    const other = create();
    expect((await other.refresh()).session).toEqual(session);
  });

  it('refuses to start a second session', async () => {
    const { manager } = setup();
    await manager.start(taskA);
    await expect(manager.start(taskB)).rejects.toBeInstanceOf(SessionActiveError);
  });

  it('pauses and resumes', async () => {
    const { manager, clock } = setup();
    await manager.start(taskA);
    clock.advance(10 * MINUTE);
    await manager.pause();
    expect(manager.session).toMatchObject({
      status: 'pausedManual',
      segments: [{ start: T0, end: T0 + 10 * MINUTE }],
    });

    clock.advance(5 * MINUTE);
    await manager.resume();
    expect(manager.session).toMatchObject({ status: 'running', openSegmentStart: T0 + 15 * MINUTE });
  });

  it('ignores session commands without a session', async () => {
    const { manager } = setup();
    const changes = vi.fn();
    manager.onDidChange(changes);
    await manager.pause();
    await manager.resume();
    await manager.autosave(T0);
    expect(manager.session).toBeNull();
    expect(changes).not.toHaveBeenCalled();
  });

  it('discards the session', async () => {
    const { manager, queued } = setup();
    await manager.start(taskA);
    await manager.discard();
    expect(manager.session).toBeNull();
    expect(queued).toEqual([]);
  });

  it('sees changes made by another window', async () => {
    const { manager, create } = setup();
    const other = create();
    await other.start(taskA);
    expect(manager.session).toBeNull();
    await manager.refresh();
    expect(manager.session?.task).toEqual(taskA);

    // Commands act on the state on disk, not on a stale cache.
    await other.pause();
    await manager.resume();
    expect(manager.session?.status).toBe('running');
  });

  it('recovers from a corrupt state file', async () => {
    const { manager } = setup();
    await writeFile(join(dir.path, 'state.json'), '{ broken', 'utf8');
    expect((await manager.refresh()).session).toBeNull();
    await manager.start(taskA);
    expect(manager.session).not.toBeNull();
  });

  it('keeps the recent tasks unique, most recent first and capped', async () => {
    const { manager } = setup();
    for (let i = 0; i < MAX_RECENT_TASKS + 2; i++) {
      await manager.start(makeTask(`task${String(i)}x1`));
      await manager.discard();
    }
    await manager.start(makeTask('task3x1'));
    const ids = manager.state.recentTasks.map((t) => t.id);
    expect(ids).toHaveLength(MAX_RECENT_TASKS);
    expect(ids[0]).toBe('task3x1');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('remembers ignored branches once', async () => {
    const { manager } = setup();
    await manager.ignoreBranch('feature/x');
    await manager.ignoreBranch('feature/x');
    expect(manager.state.ignoredBranches).toEqual(['feature/x']);
  });
});

describe('StateManager finish and switch', () => {
  it('queues one entry per segment and clears the session', async () => {
    const { manager, clock, queued } = setup();
    await manager.start(taskA);
    clock.advance(10 * MINUTE);
    await manager.pause();
    clock.advance(5 * MINUTE);
    await manager.resume();
    clock.advance(20 * MINUTE);

    const result = await manager.finish('my description', policy);

    expect(result).toMatchObject({ kind: 'entries', trackedMs: 30 * MINUTE });
    expect(queued).toEqual([
      {
        sessionId: 'session-1',
        teamId: '9000',
        taskId: 'aaa111',
        taskName: 'Task aaa111',
        start: T0,
        duration: 10 * MINUTE,
        description: 'my description',
      },
      expect.objectContaining({ start: T0 + 15 * MINUTE, duration: 20 * MINUTE }),
    ]);
    expect(manager.session).toBeNull();
  });

  it('discards a session below the minimum without queuing', async () => {
    const { manager, clock, queued } = setup();
    await manager.start(taskA);
    clock.advance(30 * SECOND);
    expect(await manager.finish('x', policy)).toMatchObject({ kind: 'discard', reason: 'belowMinimum' });
    expect(queued).toEqual([]);
    expect(manager.session).toBeNull();
  });

  it('returns undefined when finishing without a session', async () => {
    const { manager } = setup();
    expect(await manager.finish('x', policy)).toBeUndefined();
  });

  it('switches tasks, finishing the current one', async () => {
    const { manager, clock, queued } = setup();
    await manager.start(taskA);
    clock.advance(10 * MINUTE);

    const { finished, session } = await manager.switchTask(taskB, 'switch', policy);

    expect(finished).toMatchObject({ kind: 'entries' });
    expect(queued).toMatchObject([{ taskId: 'aaa111', duration: 10 * MINUTE }]);
    expect(session).toMatchObject({ id: 'session-2', task: taskB, openSegmentStart: T0 + 10 * MINUTE });
    expect(manager.state.recentTasks.map((t) => t.id)).toEqual(['bbb222', 'aaa111']);
  });

  it('switches without a current session', async () => {
    const { manager } = setup();
    const { finished, session } = await manager.switchTask(taskB, 'x', policy);
    expect(finished).toBeUndefined();
    expect(session.task).toEqual(taskB);
  });

  it('keeps the session when queuing fails', async () => {
    const { manager, queue, clock } = setup();
    await manager.start(taskA);
    clock.advance(10 * MINUTE);
    vi.mocked(queue.enqueue).mockRejectedValueOnce(new Error('disk full'));
    await expect(manager.finish('x', policy)).rejects.toThrow('disk full');
    expect((await manager.refresh()).session).not.toBeNull();
  });
});

describe('StateManager daily totals', () => {
  it('adds finished time to the day it was tracked', async () => {
    const { manager, clock } = setup();
    const day = localDayKey(T0);
    await manager.start(taskA);
    clock.advance(10 * MINUTE);
    await manager.finish('x', policy);
    await manager.start(taskB);
    clock.advance(5 * MINUTE);
    await manager.switchTask(taskA, 'y', policy);
    expect(manager.state.dailyTotals).toEqual({ [day]: 15 * MINUTE });
  });

  it('ignores discarded sessions', async () => {
    const { manager, clock } = setup();
    await manager.start(taskA);
    clock.advance(10 * SECOND);
    await manager.finish('x', policy);
    expect(manager.state.dailyTotals).toEqual({});
  });

  it('drops days older than the retention period', async () => {
    const { manager, clock } = setup();
    await manager.start(taskA);
    clock.advance(10 * MINUTE);
    await manager.finish('x', policy);

    clock.advance(DAILY_TOTALS_RETENTION_DAYS * 24 * 60 * MINUTE);
    await manager.start(taskA);
    clock.advance(10 * MINUTE);
    await manager.finish('x', policy);

    expect(Object.keys(manager.state.dailyTotals)).toEqual([localDayKey(clock.now())]);
  });
});

describe('StateManager background tick', () => {
  it('does nothing without a session or activity', async () => {
    const { manager } = setup();
    expect(await manager.tick(T0, THRESHOLD)).toBeUndefined();
    await manager.start(taskA);
    expect(await manager.tick(undefined, THRESHOLD)).toBeUndefined();
  });

  it('keeps running while there is recent activity', async () => {
    const { manager, clock } = setup();
    await manager.start(taskA);
    clock.advance(5 * MINUTE);
    expect(await manager.tick(T0 + 4 * MINUTE, THRESHOLD)).toBeUndefined();
    expect(manager.session?.status).toBe('running');
  });

  it('pauses on inactivity at the last activity', async () => {
    const { manager, clock } = setup();
    await manager.start(taskA);
    clock.advance(10 * MINUTE);
    expect(await manager.tick(T0 + 7 * MINUTE, THRESHOLD)).toEqual({ kind: 'idlePaused' });
    expect(manager.session).toMatchObject({
      status: 'pausedIdle',
      segments: [{ start: T0, end: T0 + 7 * MINUTE }],
      pausedAt: T0 + 7 * MINUTE,
    });
  });

  it('resumes automatically when activity comes back after an idle pause', async () => {
    const { manager, clock } = setup();
    await manager.start(taskA);
    clock.advance(10 * MINUTE);
    await manager.tick(T0 + 7 * MINUTE, THRESHOLD);

    clock.advance(20 * MINUTE);
    const comeback = T0 + 29 * MINUTE + 55 * SECOND;
    expect(await manager.tick(comeback, THRESHOLD)).toEqual({
      kind: 'idleResumed',
      awayMs: comeback - (T0 + 7 * MINUTE),
    });
    expect(manager.session).toMatchObject({ status: 'running', openSegmentStart: comeback });
  });

  it('stays idle-paused while there is no new activity', async () => {
    const { manager, clock } = setup();
    await manager.start(taskA);
    clock.advance(10 * MINUTE);
    await manager.tick(T0 + 7 * MINUTE, THRESHOLD);
    clock.advance(MINUTE);
    expect(await manager.tick(T0 + 7 * MINUTE, THRESHOLD)).toBeUndefined();
    expect(manager.session?.status).toBe('pausedIdle');
  });

  it('never resumes a manual pause on activity', async () => {
    const { manager, clock } = setup();
    await manager.start(taskA);
    clock.advance(MINUTE);
    await manager.pause();
    clock.advance(MINUTE);
    expect(await manager.tick(clock.now(), THRESHOLD)).toBeUndefined();
    expect(manager.session?.status).toBe('pausedManual');
  });

  it('ignores activity reported from the future', async () => {
    const { manager, clock } = setup();
    await manager.start(taskA);
    clock.advance(10 * MINUTE);
    // Activity "in the future" is clamped to now, so it counts as recent activity.
    expect(await manager.tick(T0 + 60 * MINUTE, THRESHOLD)).toBeUndefined();
  });
});

describe('StateManager autosave', () => {
  it('records the latest activity and the save time', async () => {
    const { manager, clock } = setup();
    await manager.start(taskA);
    clock.advance(MINUTE);
    await manager.autosave(T0 + 50 * SECOND);
    expect(manager.session).toMatchObject({
      lastActivityTime: T0 + 50 * SECOND,
      lastPersistedAt: T0 + MINUTE,
    });
  });

  it('saves without activity', async () => {
    const { manager, clock } = setup();
    await manager.start(taskA);
    clock.advance(MINUTE);
    await manager.autosave(undefined);
    expect(manager.session).toMatchObject({ lastActivityTime: T0, lastPersistedAt: T0 + MINUTE });
  });

  it('splits the open segment when the clock went backwards', async () => {
    const { manager, clock } = setup();
    await manager.start(taskA);
    clock.advance(10 * MINUTE);
    await manager.autosave(clock.now());
    clock.set(T0 + 5 * MINUTE);
    await manager.autosave(undefined);
    expect(manager.session).toMatchObject({
      segments: [{ start: T0, end: T0 + 10 * MINUTE }],
      openSegmentStart: T0 + 5 * MINUTE,
    });
  });
});

describe('StateManager recovery', () => {
  it('reports when there is nothing to recover', async () => {
    const { manager } = setup();
    expect(await manager.recover()).toEqual({ kind: 'none' });
  });

  it('closes a running session at the last activity and leaves it paused', async () => {
    const { manager, clock, create } = setup();
    await manager.start(taskA);
    clock.advance(30 * MINUTE);
    await manager.autosave(T0 + 25 * MINUTE);

    // The editor crashed; a new window starts two hours later.
    clock.advance(2 * 60 * MINUTE);
    const result = await create().recover();

    expect(result).toMatchObject({
      kind: 'recovered',
      session: { status: 'pausedManual', segments: [{ start: T0, end: T0 + 25 * MINUTE }] },
    });
  });

  it('leaves a paused session untouched', async () => {
    const { manager, clock } = setup();
    await manager.start(taskA);
    clock.advance(MINUTE);
    await manager.pause();
    expect(await manager.recover()).toMatchObject({ kind: 'paused', session: { status: 'pausedManual' } });
  });

  it('clears a session that was already queued before the crash', async () => {
    const { manager, queued } = setup();
    const session = await manager.start(taskA);
    queued.push({
      sessionId: session.id,
      teamId: '9000',
      taskId: 'aaa111',
      taskName: 'x',
      start: T0,
      duration: MINUTE,
      description: '',
    });
    expect(await manager.recover()).toEqual({ kind: 'alreadyQueued' });
    expect(manager.session).toBeNull();
  });
});
