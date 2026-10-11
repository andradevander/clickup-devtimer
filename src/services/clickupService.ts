import { CLICKUP_API_BASE_URL } from '../constants';
import type { TaskReference } from '../core/taskIdParser';
import type {
  ClickUpList,
  ClickUpTask,
  ClickUpTasksPage,
  ClickUpTeam,
  ClickUpTimeEntry,
  ClickUpUser,
  NewTimeEntry,
} from '../types/clickup';
import type { TaskRef } from '../types/session';
import { RateLimiter, type Clock } from './rateLimiter';

export type ClickUpErrorKind =
  | 'noToken'
  | 'unauthorized'
  | 'forbidden'
  | 'notFound'
  | 'rateLimited'
  | 'client'
  | 'server'
  | 'network'
  | 'timeout';

export class ClickUpApiError extends Error {
  override readonly name = 'ClickUpApiError';

  constructor(
    readonly kind: ClickUpErrorKind,
    message: string,
    readonly status?: number,
    /** ClickUp error code from the response body (e.g. `OAUTH_025`). */
    readonly code?: string,
    /** For `rateLimited`: how long until requests are allowed again. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }

  /** The request may have reached ClickUp, so a write may or may not have been applied. */
  get isOutcomeUnknown(): boolean {
    return this.kind === 'network' || this.kind === 'timeout';
  }

  /** Worth retrying later without user action. */
  get isTransient(): boolean {
    return this.isOutcomeUnknown || this.kind === 'server' || this.kind === 'rateLimited';
  }
}

export interface ClickUpServiceOptions {
  /** Returns the Personal Token, or `undefined` when none is configured. */
  getToken: () => Promise<string | undefined>;
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  rateLimiter?: RateLimiter;
  clock?: Clock;
}

type QueryValue = string | number | boolean | readonly (string | number)[];

interface RequestOptions {
  query?: Record<string, QueryValue | undefined>;
  body?: unknown;
}

/** ClickUp returns up to 100 tasks per page. */
const TASKS_PAGE_SIZE = 100;
/** Safety cap on pagination (1,000 tasks). */
const MAX_TASK_PAGES = 10;
const DEFAULT_TIMEOUT_MS = 15_000;

export function looksLikePersonalToken(value: string): boolean {
  return /^pk_\w+$/.test(value.trim());
}

export function toTaskRef(task: ClickUpTask): TaskRef {
  return {
    id: task.id,
    ...(task.custom_id ? { customId: task.custom_id } : {}),
    name: task.name,
    url: task.url,
    listId: task.list.id,
    teamId: task.team_id,
  };
}

/** HTTP client for the ClickUp API v2 (spec §4). */
export class ClickUpService {
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly rateLimiter: RateLimiter;
  private readonly clock: Clock;

  constructor(private readonly options: ClickUpServiceOptions) {
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.baseUrl = options.baseUrl ?? CLICKUP_API_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.clock = options.clock ?? Date.now;
    this.rateLimiter = options.rateLimiter ?? new RateLimiter(100, 60_000, this.clock);
  }

  async getUser(): Promise<ClickUpUser> {
    const { user } = await this.request<{ user: ClickUpUser }>('GET', '/user');
    return user;
  }

  async getTeams(): Promise<ClickUpTeam[]> {
    const { teams } = await this.request<{ teams: ClickUpTeam[] }>('GET', '/team');
    return teams;
  }

  /** Open tasks (including subtasks) assigned to the user, most recently updated first. */
  async getAssignedTasks(teamId: string, userId: number): Promise<ClickUpTask[]> {
    const tasks: ClickUpTask[] = [];
    for (let page = 0; page < MAX_TASK_PAGES; page++) {
      const result = await this.request<ClickUpTasksPage>('GET', `/team/${encodeURIComponent(teamId)}/task`, {
        query: {
          'assignees[]': [userId],
          include_closed: false,
          subtasks: true,
          order_by: 'updated',
          page,
        },
      });
      tasks.push(...result.tasks);
      const isLastPage = result.last_page ?? result.tasks.length < TASKS_PAGE_SIZE;
      if (isLastPage || result.tasks.length === 0) {
        break;
      }
    }
    return tasks;
  }

  async getTask(reference: TaskReference, teamId: string): Promise<ClickUpTask> {
    return this.request<ClickUpTask>('GET', `/task/${encodeURIComponent(reference.id)}`, {
      query: reference.kind === 'customId' ? { custom_task_ids: true, team_id: teamId } : {},
    });
  }

  async getList(listId: string): Promise<ClickUpList> {
    return this.request<ClickUpList>('GET', `/list/${encodeURIComponent(listId)}`);
  }

  async updateTaskStatus(taskId: string, status: string): Promise<ClickUpTask> {
    return this.request<ClickUpTask>('PUT', `/task/${encodeURIComponent(taskId)}`, { body: { status } });
  }

  /** Creates a time entry and returns its ID. */
  async createTimeEntry(teamId: string, entry: NewTimeEntry): Promise<string> {
    const { data } = await this.request<{ data: { id: string } }>(
      'POST',
      `/team/${encodeURIComponent(teamId)}/time_entries`,
      { body: entry },
    );
    return data.id;
  }

  /** Time entries of the token's user for a task within `[startDate, endDate]` (epoch ms). */
  async getTimeEntries(
    teamId: string,
    filter: { taskId: string; startDate: number; endDate: number },
  ): Promise<ClickUpTimeEntry[]> {
    const { data } = await this.request<{ data: ClickUpTimeEntry[] }>(
      'GET',
      `/team/${encodeURIComponent(teamId)}/time_entries`,
      { query: { task_id: filter.taskId, start_date: filter.startDate, end_date: filter.endDate } },
    );
    return data;
  }

  private async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const token = (await this.options.getToken())?.trim();
    if (!token) {
      throw new ClickUpApiError('noToken', 'No ClickUp Personal Token configured');
    }

    await this.rateLimiter.acquire();

    const headers: Record<string, string> = { Authorization: token, Accept: 'application/json' };
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.timeoutMs) };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await this.fetchFn(this.buildUrl(path, options.query), init);
    } catch (error) {
      throw this.toTransportError(error, method, path);
    }

    if (!response.ok) {
      throw await this.toHttpError(response, method, path);
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  private buildUrl(path: string, query: RequestOptions['query']): string {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) {
        continue;
      }
      const values = typeof value === 'object' ? value : [value];
      for (const item of values) {
        url.searchParams.append(key, String(item));
      }
    }
    return url.toString();
  }

  private toTransportError(error: unknown, method: string, path: string): ClickUpApiError {
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      return new ClickUpApiError('timeout', `${method} ${path} timed out after ${this.timeoutMs} ms`);
    }
    const detail = error instanceof Error ? error.message : String(error);
    return new ClickUpApiError('network', `${method} ${path} failed: ${detail}`);
  }

  private async toHttpError(response: Response, method: string, path: string): Promise<ClickUpApiError> {
    let code: string | undefined;
    let detail = response.statusText;
    try {
      const body = (await response.json()) as { err?: unknown; ECODE?: unknown };
      if (typeof body.err === 'string') {
        detail = body.err;
      }
      if (typeof body.ECODE === 'string') {
        code = body.ECODE;
      }
    } catch {
      // Body is not JSON; keep the status text.
    }
    const message = `${method} ${path} failed with ${response.status}: ${detail}`;

    switch (response.status) {
      case 401:
        return new ClickUpApiError('unauthorized', message, 401, code);
      case 403:
        return new ClickUpApiError('forbidden', message, 403, code);
      case 404:
        return new ClickUpApiError('notFound', message, 404, code);
      case 429: {
        const retryAfterMs = this.retryAfterMs(response);
        this.rateLimiter.blockUntil(this.clock() + retryAfterMs);
        return new ClickUpApiError('rateLimited', message, 429, code, retryAfterMs);
      }
      default:
        return new ClickUpApiError(
          response.status >= 500 ? 'server' : 'client',
          message,
          response.status,
          code,
        );
    }
  }

  /** From `X-RateLimit-Reset` (epoch seconds); falls back to one minute. */
  private retryAfterMs(response: Response): number {
    const reset = Number(response.headers.get('X-RateLimit-Reset'));
    if (Number.isFinite(reset) && reset > 0) {
      return Math.max(0, reset * 1000 - this.clock());
    }
    return 60_000;
  }
}
