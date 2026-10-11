import type { ClickUpStatus, ClickUpTask } from '../types/clickup';
import type { TaskRef } from '../types/session';

export interface RecentEntry {
  ref: TaskRef;
  /** The up-to-date task when it is also in the assigned list. */
  task?: ClickUpTask;
}

export interface TaskGroups {
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

/** Splits tasks into the picker sections, without repeating a task in more than one section. */
export function groupTasks(
  assigned: readonly ClickUpTask[],
  recentTasks: readonly TaskRef[],
  activeStatuses: readonly string[],
  recentCount: number,
): TaskGroups {
  const byId = new Map(assigned.map((task) => [task.id, task]));
  const recent = recentTasks.slice(0, Math.max(0, recentCount)).map((ref): RecentEntry => {
    const task = byId.get(ref.id);
    return task === undefined ? { ref } : { ref, task };
  });
  const recentIds = new Set(recent.map((entry) => entry.ref.id));
  const remaining = assigned.filter((task) => !recentIds.has(task.id));
  return {
    recent,
    active: remaining.filter((task) => isActiveStatus(task.status.status, activeStatuses)),
    others: remaining.filter((task) => !isActiveStatus(task.status.status, activeStatuses)),
  };
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
