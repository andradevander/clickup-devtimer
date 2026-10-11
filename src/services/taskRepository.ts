import type { TaskReference } from '../core/taskIdParser';
import type { ClickUpList, ClickUpTask, ClickUpUser } from '../types/clickup';
import type { ClickUpService } from './clickupService';
import type { Clock } from './rateLimiter';

export type TaskClient = Pick<ClickUpService, 'getUser' | 'getAssignedTasks' | 'getTask' | 'getList'>;

interface CachedTasks {
  teamId: string;
  tasks: ClickUpTask[];
  loadedAt: number;
}

/** Cached access to the user's tasks (spec §3.4: task list cached for `taskCacheTtlMinutes`). */
export class TaskRepository {
  private user: ClickUpUser | undefined;
  private assigned: CachedTasks | undefined;
  private readonly lists = new Map<string, ClickUpList>();

  constructor(
    private readonly client: TaskClient,
    private readonly ttlMs: () => number,
    private readonly clock: Clock = Date.now,
  ) {}

  async currentUser(): Promise<ClickUpUser> {
    this.user ??= await this.client.getUser();
    return this.user;
  }

  async assignedTasks(teamId: string, force = false): Promise<ClickUpTask[]> {
    const cached = this.assigned;
    if (!force && cached?.teamId === teamId && this.clock() - cached.loadedAt < this.ttlMs()) {
      return cached.tasks;
    }
    const user = await this.currentUser();
    const tasks = await this.client.getAssignedTasks(teamId, user.id);
    this.assigned = { teamId, tasks, loadedAt: this.clock() };
    return tasks;
  }

  /** Fetches a task by ID or custom ID (always from the API, so the status is current). */
  async resolve(reference: TaskReference, teamId: string): Promise<ClickUpTask> {
    return this.client.getTask(reference, teamId);
  }

  /** Lists rarely change their statuses, so they are cached until {@link invalidate}. */
  async list(listId: string): Promise<ClickUpList> {
    const cached = this.lists.get(listId);
    if (cached !== undefined) {
      return cached;
    }
    const list = await this.client.getList(listId);
    this.lists.set(listId, list);
    return list;
  }

  /** Drops task caches (e.g. after a status change); keeps the user unless `includeUser`. */
  invalidate(includeUser = false): void {
    this.assigned = undefined;
    this.lists.clear();
    if (includeUser) {
      this.user = undefined;
    }
  }
}
