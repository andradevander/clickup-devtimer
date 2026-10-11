import { describe, expect, it } from 'vitest';
import {
  ClickUpApiError,
  ClickUpService,
  looksLikePersonalToken,
  toTaskRef,
} from '../../../src/services/clickupService';
import { RateLimiter } from '../../../src/services/rateLimiter';
import type { ClickUpTask } from '../../../src/types/clickup';

const TOKEN = 'pk_000_FAKE';
const NOW = 1_760_000_000_000;

interface RecordedCall {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

type Responder = (call: RecordedCall) => Response | Promise<Response>;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function setup(responders: Responder[], token: string | null = TOKEN) {
  const calls: RecordedCall[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: RecordedCall = {
      method: init?.method ?? 'GET',
      url: new URL(input instanceof Request ? input.url : input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const responder = responders.shift();
    if (!responder) {
      throw new Error(`Unexpected request ${call.method} ${call.url.pathname}`);
    }
    return responder(call);
  }) as typeof fetch;

  const limiter = new RateLimiter(
    100,
    60_000,
    () => NOW,
    () => Promise.resolve(),
  );
  const service = new ClickUpService({
    getToken: () => Promise.resolve(token ?? undefined),
    fetch: fetchFn,
    baseUrl: 'https://api.test/api/v2',
    rateLimiter: limiter,
    clock: () => NOW,
  });
  return { service, calls, limiter };
}

function fakeTask(id: string, overrides: Partial<ClickUpTask> = {}): ClickUpTask {
  return {
    id,
    custom_id: null,
    name: `Task ${id}`,
    url: `https://app.clickup.com/t/${id}`,
    status: { status: 'in progress', type: 'custom', color: '#000' },
    list: { id: 'list1', name: 'List 1' },
    folder: { id: 'folder1', name: 'Fictional Client' },
    space: { id: 'space1' },
    team_id: 'team1',
    date_updated: null,
    ...overrides,
  };
}

describe('looksLikePersonalToken', () => {
  it.each([
    ['pk_12345678_ABCDEF', true],
    ['  pk_12345678_ABCDEF  ', true],
    ['12345678_ABCDEF', false],
    ['pk_', false],
    ['pk_123 456', false],
  ])('%j -> %s', (value, expected) => {
    expect(looksLikePersonalToken(value)).toBe(expected);
  });
});

describe('toTaskRef', () => {
  it('maps a task without a custom ID', () => {
    expect(toTaskRef(fakeTask('abc123'))).toEqual({
      id: 'abc123',
      name: 'Task abc123',
      url: 'https://app.clickup.com/t/abc123',
      listId: 'list1',
      teamId: 'team1',
    });
  });

  it('keeps the custom ID', () => {
    expect(toTaskRef(fakeTask('abc123', { custom_id: 'DEV-1' })).customId).toBe('DEV-1');
  });
});

describe('ClickUpService requests', () => {
  it('sends the token and parses the user', async () => {
    const { service, calls } = setup([
      () => json({ user: { id: 7, username: 'dev', email: 'dev@example.com' } }),
    ]);
    await expect(service.getUser()).resolves.toEqual({ id: 7, username: 'dev', email: 'dev@example.com' });
    expect(calls[0]?.url.toString()).toBe('https://api.test/api/v2/user');
    expect(calls[0]?.headers.Authorization).toBe(TOKEN);
  });

  it('lists teams', async () => {
    const { service } = setup([() => json({ teams: [{ id: '1', name: 'Workspace' }] })]);
    await expect(service.getTeams()).resolves.toEqual([{ id: '1', name: 'Workspace' }]);
  });

  it('paginates assigned tasks until the last page', async () => {
    const { service, calls } = setup([
      () => json({ tasks: [fakeTask('a'), fakeTask('b')], last_page: false }),
      () => json({ tasks: [fakeTask('c')], last_page: true }),
    ]);
    const tasks = await service.getAssignedTasks('team1', 7);
    expect(tasks.map((t) => t.id)).toEqual(['a', 'b', 'c']);
    expect(calls).toHaveLength(2);
    const query = calls[0]?.url.searchParams;
    expect(calls[0]?.url.pathname).toBe('/api/v2/team/team1/task');
    expect(query?.getAll('assignees[]')).toEqual(['7']);
    expect(query?.get('include_closed')).toBe('false');
    expect(query?.get('subtasks')).toBe('true');
    expect(query?.get('order_by')).toBe('updated');
    expect(query?.get('page')).toBe('0');
    expect(calls[1]?.url.searchParams.get('page')).toBe('1');
  });

  it('stops paginating on a short page when last_page is missing', async () => {
    const { service, calls } = setup([() => json({ tasks: [fakeTask('a')] })]);
    await service.getAssignedTasks('team1', 7);
    expect(calls).toHaveLength(1);
  });

  it('stops paginating on an empty page', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => fakeTask(`t${i}`));
    const { service, calls } = setup([() => json({ tasks: fullPage }), () => json({ tasks: [] })]);
    expect(await service.getAssignedTasks('team1', 7)).toHaveLength(100);
    expect(calls).toHaveLength(2);
  });

  it('caps pagination at 10 pages', async () => {
    const page = () => json({ tasks: [fakeTask('x')], last_page: false });
    const { service, calls } = setup(Array.from({ length: 11 }, () => page));
    await service.getAssignedTasks('team1', 7);
    expect(calls).toHaveLength(10);
  });

  it('fetches a task by ID', async () => {
    const { service, calls } = setup([() => json(fakeTask('abc123'))]);
    await service.getTask({ kind: 'id', id: 'abc123' }, 'team1');
    expect(calls[0]?.url.pathname).toBe('/api/v2/task/abc123');
    expect(calls[0]?.url.search).toBe('');
  });

  it('fetches a task by custom ID', async () => {
    const { service, calls } = setup([() => json(fakeTask('abc123', { custom_id: 'DEV-1' }))]);
    await service.getTask({ kind: 'customId', id: 'DEV-1' }, 'team1');
    expect(calls[0]?.url.pathname).toBe('/api/v2/task/DEV-1');
    expect(calls[0]?.url.searchParams.get('custom_task_ids')).toBe('true');
    expect(calls[0]?.url.searchParams.get('team_id')).toBe('team1');
  });

  it('gets a list', async () => {
    const list = { id: 'list1', name: 'List', statuses: [{ status: 'to do', type: 'open', color: '#ccc' }] };
    const { service, calls } = setup([() => json(list)]);
    await expect(service.getList('list1')).resolves.toEqual(list);
    expect(calls[0]?.url.pathname).toBe('/api/v2/list/list1');
  });

  it('updates the task status', async () => {
    const { service, calls } = setup([() => json(fakeTask('abc123'))]);
    await service.updateTaskStatus('abc123', 'in progress');
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.headers['Content-Type']).toBe('application/json');
    expect(calls[0]?.body).toEqual({ status: 'in progress' });
  });

  it('creates a time entry', async () => {
    const { service, calls } = setup([() => json({ data: { id: 'entry1' } })]);
    const entry = { tid: 'abc123', start: NOW, duration: 600_000, description: 'feature/CU-abc123' };
    await expect(service.createTimeEntry('team1', entry)).resolves.toBe('entry1');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe('/api/v2/team/team1/time_entries');
    expect(calls[0]?.body).toEqual(entry);
  });

  it('queries time entries of a task', async () => {
    const entries = [
      { id: 'e1', start: String(NOW), duration: '600000', description: '', task: { id: 'abc123' } },
    ];
    const { service, calls } = setup([() => json({ data: entries })]);
    await expect(
      service.getTimeEntries('team1', { taskId: 'abc123', startDate: 1, endDate: 2 }),
    ).resolves.toEqual(entries);
    const query = calls[0]?.url.searchParams;
    expect(query?.get('task_id')).toBe('abc123');
    expect(query?.get('start_date')).toBe('1');
    expect(query?.get('end_date')).toBe('2');
  });

  it('accepts empty responses', async () => {
    const { service } = setup([() => new Response(null, { status: 204 })]);
    await expect(service.updateTaskStatus('abc123', 'done')).resolves.toBeUndefined();
  });

  it('encodes path segments', async () => {
    const { service, calls } = setup([() => json(fakeTask('x'))]);
    await service.getTask({ kind: 'id', id: 'a/b' }, 'team1');
    expect(calls[0]?.url.pathname).toBe('/api/v2/task/a%2Fb');
  });
});

describe('ClickUpService errors', () => {
  async function errorOf(promise: Promise<unknown>): Promise<ClickUpApiError> {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(ClickUpApiError);
      return error as ClickUpApiError;
    }
    throw new Error('Expected the request to fail');
  }

  it('fails without a token and does not call the API', async () => {
    const { service, calls } = setup([], null);
    expect((await errorOf(service.getUser())).kind).toBe('noToken');
    expect(calls).toHaveLength(0);
  });

  it('treats a blank token as missing', async () => {
    const { service } = setup([], '   ');
    expect((await errorOf(service.getUser())).kind).toBe('noToken');
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'notFound'],
    [400, 'client'],
    [500, 'server'],
    [503, 'server'],
  ] as const)('maps HTTP %i to %s', async (status, kind) => {
    const { service } = setup([() => json({ err: 'Something failed', ECODE: 'TEST_001' }, status)]);
    const error = await errorOf(service.getUser());
    expect(error.kind).toBe(kind);
    expect(error.status).toBe(status);
    expect(error.code).toBe('TEST_001');
    expect(error.message).toContain('Something failed');
  });

  it('handles non-JSON error bodies', async () => {
    const { service } = setup([
      () => new Response('<html>Bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }),
    ]);
    const error = await errorOf(service.getUser());
    expect(error.kind).toBe('server');
    expect(error.code).toBeUndefined();
    expect(error.message).toContain('Bad Gateway');
  });

  it('blocks the rate limiter until the reset time on 429', async () => {
    const resetSeconds = Math.floor(NOW / 1000) + 30;
    const { service, limiter } = setup([
      () => json({ err: 'Rate limit', ECODE: 'APP_002' }, 429, { 'X-RateLimit-Reset': String(resetSeconds) }),
    ]);
    const error = await errorOf(service.getUser());
    expect(error.kind).toBe('rateLimited');
    expect(error.retryAfterMs).toBe(resetSeconds * 1000 - NOW);
    expect(error.isTransient).toBe(true);
    expect((limiter as unknown as { blockedUntil: number }).blockedUntil).toBe(resetSeconds * 1000);
  });

  it('waits one minute on 429 without a reset header', async () => {
    const { service } = setup([() => json({}, 429)]);
    expect((await errorOf(service.getUser())).retryAfterMs).toBe(60_000);
  });

  it('maps network failures', async () => {
    const { service } = setup([
      () => {
        throw new TypeError('fetch failed');
      },
    ]);
    const error = await errorOf(service.getUser());
    expect(error.kind).toBe('network');
    expect(error.isOutcomeUnknown).toBe(true);
    expect(error.isTransient).toBe(true);
  });

  it('maps timeouts', async () => {
    const { service } = setup([
      () => {
        throw new DOMException('The operation timed out.', 'TimeoutError');
      },
    ]);
    const error = await errorOf(service.getUser());
    expect(error.kind).toBe('timeout');
    expect(error.isOutcomeUnknown).toBe(true);
  });

  it('maps non-Error rejections', async () => {
    const { service } = setup([
      () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- simulating a misbehaving fetch
        throw 'boom';
      },
    ]);
    const error = await errorOf(service.getUser());
    expect(error.kind).toBe('network');
    expect(error.message).toContain('boom');
  });

  it('marks client errors as permanent', async () => {
    const { service } = setup([() => json({}, 400)]);
    const error = await errorOf(service.getUser());
    expect(error.isTransient).toBe(false);
    expect(error.isOutcomeUnknown).toBe(false);
  });

  it('aborts slow requests using the configured timeout', async () => {
    let signal: AbortSignal | undefined;
    const service = new ClickUpService({
      getToken: () => Promise.resolve(TOKEN),
      timeoutMs: 10,
      rateLimiter: new RateLimiter(
        100,
        60_000,
        () => NOW,
        () => Promise.resolve(),
      ),
      fetch: ((_input: string, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(signal?.reason as Error);
          });
        });
      }) as typeof fetch,
    });
    const error = await errorOf(service.getUser());
    expect(error.kind).toBe('timeout');
  });
});
