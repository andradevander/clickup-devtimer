import { describe, expect, it, vi } from 'vitest';
import { TaskRepository, type TaskClient } from '../../../src/services/taskRepository';
import type { ClickUpList, ClickUpTask } from '../../../src/types/clickup';
import { fakeClock } from '../helpers';

const T0 = 1_760_000_000_000;
const TTL = 5 * 60_000;

const task = { id: 'abc123xyz', name: 'Fictional task' } as ClickUpTask;
const list: ClickUpList = { id: 'list1', name: 'List', statuses: [] };

function setup() {
  const clock = fakeClock(T0);
  const client = {
    getUser: vi
      .fn<TaskClient['getUser']>()
      .mockResolvedValue({ id: 7, username: 'dev', email: 'dev@example.com' }),
    getAssignedTasks: vi.fn<TaskClient['getAssignedTasks']>().mockResolvedValue([task]),
    getTask: vi.fn<TaskClient['getTask']>().mockResolvedValue(task),
    getList: vi.fn<TaskClient['getList']>().mockResolvedValue(list),
  };
  const repository = new TaskRepository(client, () => TTL, clock.now);
  return { clock, client, repository };
}

describe('TaskRepository', () => {
  it('caches the current user', async () => {
    const { repository, client } = setup();
    await repository.currentUser();
    await repository.currentUser();
    expect(client.getUser).toHaveBeenCalledTimes(1);
  });

  it('loads assigned tasks for the current user and caches them for the TTL', async () => {
    const { repository, client, clock } = setup();
    expect(await repository.assignedTasks('9000')).toEqual([task]);
    expect(client.getAssignedTasks).toHaveBeenCalledWith('9000', 7);

    clock.advance(TTL - 1);
    await repository.assignedTasks('9000');
    expect(client.getAssignedTasks).toHaveBeenCalledTimes(1);

    clock.advance(1);
    await repository.assignedTasks('9000');
    expect(client.getAssignedTasks).toHaveBeenCalledTimes(2);
  });

  it('reloads when forced or when the Workspace changes', async () => {
    const { repository, client } = setup();
    await repository.assignedTasks('9000');
    await repository.assignedTasks('9000', true);
    await repository.assignedTasks('9001');
    expect(client.getAssignedTasks).toHaveBeenCalledTimes(3);
  });

  it('always resolves tasks from the API', async () => {
    const { repository, client } = setup();
    await repository.resolve({ kind: 'customId', id: 'DEV-1' }, '9000');
    await repository.resolve({ kind: 'customId', id: 'DEV-1' }, '9000');
    expect(client.getTask).toHaveBeenCalledTimes(2);
    expect(client.getTask).toHaveBeenCalledWith({ kind: 'customId', id: 'DEV-1' }, '9000');
  });

  it('caches lists until invalidated', async () => {
    const { repository, client } = setup();
    await repository.list('list1');
    await repository.list('list1');
    expect(client.getList).toHaveBeenCalledTimes(1);
    repository.invalidate();
    await repository.list('list1');
    expect(client.getList).toHaveBeenCalledTimes(2);
  });

  it('keeps the user on a plain invalidate and drops it when asked', async () => {
    const { repository, client } = setup();
    await repository.assignedTasks('9000');
    repository.invalidate();
    await repository.assignedTasks('9000');
    expect(client.getUser).toHaveBeenCalledTimes(1);
    expect(client.getAssignedTasks).toHaveBeenCalledTimes(2);

    repository.invalidate(true);
    await repository.currentUser();
    expect(client.getUser).toHaveBeenCalledTimes(2);
  });
});
