import type * as fsPromises from 'node:fs/promises';
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JsonFileStore, defaultStorageDirectory, type Validator } from '../../../src/services/storageService';
import { homedir } from 'node:os';

// Wrap `rename` so tests can simulate the transient failures Windows raises while another window reads the file.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

interface Counter {
  schemaVersion: 1;
  count: number;
}

const validateCounter: Validator<Counter> = (value) => {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const candidate = value as Partial<Counter>;
  return candidate.schemaVersion === 1 && typeof candidate.count === 'number'
    ? { schemaVersion: 1, count: candidate.count }
    : undefined;
};

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'clickup-devtimer-test-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function store(dir = directory) {
  return new JsonFileStore<Counter>(dir, 'state.json', { validate: validateCounter });
}

describe('JsonFileStore', () => {
  it('reads a missing file as undefined', async () => {
    await expect(store().read()).resolves.toBeUndefined();
  });

  it('writes and reads back', async () => {
    await store().write({ schemaVersion: 1, count: 3 });
    await expect(store().read()).resolves.toEqual({ schemaVersion: 1, count: 3 });
  });

  it('creates the storage directory when needed', async () => {
    const nested = join(directory, 'a', 'b');
    await store(nested).write({ schemaVersion: 1, count: 1 });
    await expect(store(nested).read()).resolves.toEqual({ schemaVersion: 1, count: 1 });
  });

  it('leaves no temp files behind', async () => {
    await store().write({ schemaVersion: 1, count: 1 });
    await store().write({ schemaVersion: 1, count: 2 });
    expect(await readdir(directory)).toEqual(['state.json']);
  });

  it('updates the current value', async () => {
    const s = store();
    await s.update((current) => ({ schemaVersion: 1, count: (current?.count ?? 0) + 1 }));
    const result = await s.update((current) => ({ schemaVersion: 1, count: (current?.count ?? 0) + 1 }));
    expect(result.count).toBe(2);
    await expect(s.read()).resolves.toEqual({ schemaVersion: 1, count: 2 });
  });

  it('quarantines corrupt JSON', async () => {
    await writeFile(join(directory, 'state.json'), '{ not json', 'utf8');
    await expect(store().read()).resolves.toBeUndefined();
    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^state\.json\.corrupt-\d+$/);
    expect(await readFile(join(directory, files[0] ?? ''), 'utf8')).toBe('{ not json');
  });

  it('quarantines values that fail validation', async () => {
    await writeFile(join(directory, 'state.json'), JSON.stringify({ schemaVersion: 99 }), 'utf8');
    await expect(store().read()).resolves.toBeUndefined();
    expect((await readdir(directory))[0]).toMatch(/^state\.json\.corrupt-/);
  });

  it('deletes the file', async () => {
    const s = store();
    await s.write({ schemaVersion: 1, count: 1 });
    await s.delete();
    await s.delete(); // deleting a missing file is fine
    await expect(s.read()).resolves.toBeUndefined();
  });

  it('rethrows unexpected read errors', async () => {
    // Reading a directory fails with EISDIR (or EPERM on some platforms), not ENOENT.
    const s = new JsonFileStore<Counter>(join(directory, '..'), directory.split(/[\\/]/).at(-1) ?? '', {
      validate: validateCounter,
    });
    await expect(s.read()).rejects.toThrow();
  });

  describe('when rename fails', () => {
    afterEach(() => {
      vi.mocked(rename).mockClear();
    });

    it('retries transient errors', async () => {
      vi.mocked(rename).mockRejectedValueOnce(fsError('EPERM')).mockRejectedValueOnce(fsError('EBUSY'));
      const s = new JsonFileStore<Counter>(directory, 'state.json', {
        validate: validateCounter,
        renameRetryDelayMs: 1,
      });
      await s.write({ schemaVersion: 1, count: 5 });
      await expect(s.read()).resolves.toEqual({ schemaVersion: 1, count: 5 });
      expect(vi.mocked(rename)).toHaveBeenCalledTimes(3);
    });

    it('gives up after the retry limit and removes the temp file', async () => {
      vi.mocked(rename).mockRejectedValue(fsError('EACCES'));
      const s = new JsonFileStore<Counter>(directory, 'state.json', {
        validate: validateCounter,
        renameRetries: 2,
        renameRetryDelayMs: 1,
      });
      await expect(s.write({ schemaVersion: 1, count: 1 })).rejects.toThrow('EACCES');
      expect(vi.mocked(rename)).toHaveBeenCalledTimes(3);
      expect(await readdir(directory)).toEqual([]);
      vi.mocked(rename).mockReset();
    });

    it('does not retry other errors', async () => {
      vi.mocked(rename).mockRejectedValueOnce(fsError('ENOSPC'));
      await expect(store().write({ schemaVersion: 1, count: 1 })).rejects.toThrow('ENOSPC');
      expect(vi.mocked(rename)).toHaveBeenCalledTimes(1);
    });

    it('tolerates a corrupt file already moved by another window', async () => {
      await writeFile(join(directory, 'state.json'), '{ not json', 'utf8');
      vi.mocked(rename).mockRejectedValueOnce(fsError('ENOENT'));
      await expect(store().read()).resolves.toBeUndefined();
    });
  });

  it('exposes the file path', () => {
    expect(store().path).toBe(join(directory, 'state.json'));
  });
});

describe('defaultStorageDirectory', () => {
  it('lives in the user home folder, shared across editors', () => {
    expect(defaultStorageDirectory({})).toBe(join(homedir(), '.clickup-devtimer'));
  });

  it('can be overridden through the environment', () => {
    expect(defaultStorageDirectory({ CLICKUP_DEVTIMER_STORAGE_DIR: '/tmp/x' })).toBe('/tmp/x');
    expect(defaultStorageDirectory({ CLICKUP_DEVTIMER_STORAGE_DIR: '' })).toBe(
      join(homedir(), '.clickup-devtimer'),
    );
  });
});
