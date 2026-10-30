import type { ClickUpStatus, ClickUpTask } from '../types/clickup';
import type { TaskRef } from '../types/session';
import type { TaskReference } from './taskIdParser';

export interface RecentEntry {
  ref: TaskRef;
  /** The up-to-date task when it is also in the assigned list. */
  task?: ClickUpTask;
}

/** A branch task: the assigned task when known, otherwise the recent entry. */
export type BranchEntry = { task: ClickUpTask } | { ref: TaskRef };

export interface TaskGroups {
  /** Tasks named by the current Git branch (spec §3.9), shown first. */
  branch: BranchEntry[];
  recent: RecentEntry[];
  /** Assigned tasks in an active status (spec §3.4 "In progress"). */
  active: ClickUpTask[];
  /** Remaining assigned, open tasks. */
  others: ClickUpTask[];
}

function normalize(status: string): string {
  return status.trim().toLowerCase();
}

export function isActiveStatus(status: string, activeStatuses: readonly string[]): boolean {
  const normalized = normalize(status);
  return activeStatuses.some((active) => normalize(active) === normalized);
}

export interface GroupContext {
  /**
   * The task being timed; moved to the end of its section so Enter usually picks another task. It is
   * still first when it is alone in the first non-empty section (e.g. Recent holds only it).
   */
  currentTaskId?: string | undefined;
  /** References parsed from the current Git branch. */
  branchReferences?: readonly TaskReference[] | undefined;
}

function matchesReference(
  id: string,
  customId: string | null | undefined,
  reference: TaskReference,
): boolean {
  return reference.kind === 'id' ? id === reference.id : customId?.toUpperCase() === reference.id;
}

/** The assigned or recent task a branch reference points to, if it is known locally. */
function findBranchEntry(
  reference: TaskReference,
  assigned: readonly ClickUpTask[],
  recentTasks: readonly TaskRef[],
): BranchEntry | undefined {
  const task = assigned.find((item) => matchesReference(item.id, item.custom_id, reference));
  if (task !== undefined) {
    return { task };
  }
  const ref = recentTasks.find((item) => matchesReference(item.id, item.customId, reference));
  return ref === undefined ? undefined : { ref };
}

export function branchEntryId(entry: BranchEntry): string {
  return 'task' in entry ? entry.task.id : entry.ref.id;
}

/** Moves the item with `id` to the end of the list, keeping the order of the others. */
function moveToEnd<T>(items: T[], idOf: (item: T) => string, id: string | undefined): T[] {
  const index = items.findIndex((item) => idOf(item) === id);
  return index < 0 ? items : [...items.slice(0, index), ...items.slice(index + 1), items[index] as T];
}

/** Splits tasks into the picker sections, without repeating a task in more than one section. */
export function groupTasks(
  assigned: readonly ClickUpTask[],
  recentTasks: readonly TaskRef[],
  activeStatuses: readonly string[],
  recentCount: number,
  context: GroupContext = {},
): TaskGroups {
  const { currentTaskId } = context;
  const branch: BranchEntry[] = [];
  const branchIds = new Set<string>();
  for (const reference of context.branchReferences ?? []) {
    const entry = findBranchEntry(reference, assigned, recentTasks);
    const id = entry === undefined ? undefined : branchEntryId(entry);
    if (entry !== undefined && id !== undefined && id !== currentTaskId && !branchIds.has(id)) {
      branch.push(entry);
      branchIds.add(id);
    }
  }
  const byId = new Map(assigned.map((task) => [task.id, task]));
  const recent = recentTasks
    .filter((ref) => !branchIds.has(ref.id))
    .slice(0, Math.max(0, recentCount))
    .map((ref): RecentEntry => {
      const task = byId.get(ref.id);
      return task === undefined ? { ref } : { ref, task };
    });
  const shownIds = new Set([...branchIds, ...recent.map((entry) => entry.ref.id)]);
  const remaining = assigned.filter((task) => !shownIds.has(task.id));
  const byTaskId = (task: ClickUpTask) => task.id;
  return {
    branch,
    recent: moveToEnd(recent, (entry) => entry.ref.id, currentTaskId),
    active: moveToEnd(
      remaining.filter((task) => isActiveStatus(task.status.status, activeStatuses)),
      byTaskId,
      currentTaskId,
    ),
    others: moveToEnd(
      remaining.filter((task) => !isActiveStatus(task.status.status, activeStatuses)),
      byTaskId,
      currentTaskId,
    ),
  };
}

/** Where a task lives: `Folder › List`, or just the list when the folder is hidden. */
export function taskLocation(task: ClickUpTask): string {
  return task.folder.hidden === true ? task.list.name : `${task.folder.name} › ${task.list.name}`;
}

/** Whether the tasks come from more than one list, i.e. whether showing the location helps. */
export function spansSeveralLists(tasks: readonly ClickUpTask[]): boolean {
  return new Set(tasks.map((task) => task.list.id)).size > 1;
}

/** The first configured active status that exists in the task's list, with the list's own casing. */
export function pickTargetStatus(
  listStatuses: readonly ClickUpStatus[],
  activeStatuses: readonly string[],
): string | undefined {
  for (const active of activeStatuses) {
    const match = listStatuses.find((status) => normalize(status.status) === normalize(active));
    if (match !== undefined) {
      return match.status;
    }
  }
  return undefined;
}

/** Shortens text to `max` characters with an ellipsis; `max <= 0` returns an empty string. */
export function truncate(text: string, max: number): string {
  if (max <= 0) {
    return '';
  }
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
