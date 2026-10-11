import { describe, expect, it } from 'vitest';
import { groupTasks, isActiveStatus, pickTargetStatus, truncate } from '../../../src/core/taskSelection';
import type { ClickUpTask } from '../../../src/types/clickup';
import type { TaskRef } from '../../../src/types/session';

const ACTIVE = ['in progress', 'Doing'];

function fakeTask(id: string, status: string): ClickUpTask {
  return {
    id,
    custom_id: null,
    name: `Task ${id}`,
    url: `https://app.clickup.com/t/${id}`,
    status: { status, type: 'custom', color: '#000' },
    list: { id: 'list1', name: 'List' },
    folder: { id: 'folder1', name: 'Folder' },
    space: { id: 'space1' },
    team_id: '9000',
    date_updated: null,
  };
}

function ref(id: string): TaskRef {
  return {
    id,
    name: `Recent ${id}`,
    url: `https://app.clickup.com/t/${id}`,
    listId: 'list1',
    teamId: '9000',
  };
}

describe('isActiveStatus', () => {
  it('compares statuses ignoring case and spaces', () => {
    expect(isActiveStatus('In Progress', ACTIVE)).toBe(true);
    expect(isActiveStatus(' doing ', ACTIVE)).toBe(true);
    expect(isActiveStatus('to do', ACTIVE)).toBe(false);
  });
});

describe('groupTasks', () => {
  const assigned = [
    fakeTask('a', 'in progress'),
    fakeTask('b', 'to do'),
    fakeTask('c', 'doing'),
    fakeTask('d', 'review'),
  ];

  it('splits assigned tasks into active and others, keeping order', () => {
    const groups = groupTasks(assigned, [], ACTIVE, 5);
    expect(groups.recent).toEqual([]);
    expect(groups.active.map((t) => t.id)).toEqual(['a', 'c']);
    expect(groups.others.map((t) => t.id)).toEqual(['b', 'd']);
  });

  it('puts recent tasks first without repeating them, attaching the fresh task when known', () => {
    const groups = groupTasks(assigned, [ref('c'), ref('zzz'), ref('b')], ACTIVE, 5);
    expect(groups.recent).toEqual([
      { ref: ref('c'), task: assigned[2] },
      { ref: ref('zzz') },
      { ref: ref('b'), task: assigned[1] },
    ]);
    expect(groups.active.map((t) => t.id)).toEqual(['a']);
    expect(groups.others.map((t) => t.id)).toEqual(['d']);
  });

  it('limits the number of recent tasks', () => {
    expect(groupTasks(assigned, [ref('a'), ref('b')], ACTIVE, 1).recent).toHaveLength(1);
    expect(groupTasks(assigned, [ref('a')], ACTIVE, 0).recent).toEqual([]);
    expect(groupTasks(assigned, [ref('a')], ACTIVE, -1).recent).toEqual([]);
  });
});

describe('pickTargetStatus', () => {
  const statuses = [
    { status: 'to do', type: 'open', color: '#ccc' },
    { status: 'DOING', type: 'custom', color: '#00f' },
    { status: 'In Progress', type: 'custom', color: '#0f0' },
  ];

  it('returns the first configured active status present in the list, in the list casing', () => {
    expect(pickTargetStatus(statuses, ACTIVE)).toBe('In Progress');
    expect(pickTargetStatus(statuses, ['doing', 'in progress'])).toBe('DOING');
  });

  it('returns undefined when no active status exists in the list', () => {
    expect(pickTargetStatus(statuses, ['in dev'])).toBeUndefined();
  });
});

describe('truncate', () => {
  it.each([
    ['Fix login bug', 30, 'Fix login bug'],
    ['Fix login bug', 13, 'Fix login bug'],
    ['Fix login bug', 8, 'Fix log…'],
    ['Fix login bug', 5, 'Fix…'],
    ['Fix login bug', 1, '…'],
    ['Fix login bug', 0, ''],
  ])('truncate(%j, %i) = %j', (text, max, expected) => {
    expect(truncate(text, max)).toBe(expected);
  });
});
