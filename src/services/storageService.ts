import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { STORAGE_DIRECTORY_NAME } from '../constants';

/** Returns the value when it has the expected shape, or `undefined` to treat the file as invalid. */
export type Validator<T> = (value: unknown) => T | undefined;

export interface JsonFileStoreOptions<T> {
  validate: Validator<T>;
  /** Retries for `rename`, which can fail on Windows while another window reads the file. */
  renameRetries?: number;
  renameRetryDelayMs?: number;
}

/** Default storage directory, shared by every VS Code-based editor of the user (spec §5). */
export function defaultStorageDirectory(): string {
  return join(homedir(), STORAGE_DIRECTORY_NAME);
}

const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
}

let tempCounter = 0;

/**
 * A JSON file in the extension's global storage, shared by every VS Code window (spec §5).
 * Writes are atomic (temp file + rename), so readers never see a half-written file. Invalid or
 * corrupt files are moved aside as `<name>.corrupt-<timestamp>` and read as missing.
 */
export class JsonFileStore<T> {
  readonly path: string;
  private readonly renameRetries: number;
  private readonly renameRetryDelayMs: number;

  constructor(
    private readonly directory: string,
    private readonly fileName: string,
    private readonly options: JsonFileStoreOptions<T>,
  ) {
    this.path = join(directory, fileName);
    this.renameRetries = options.renameRetries ?? 5;
    this.renameRetryDelayMs = options.renameRetryDelayMs ?? 20;
  }

  async read(): Promise<T | undefined> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return undefined;
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      await this.quarantine();
      return undefined;
    }

    const value = this.options.validate(parsed);
    if (value === undefined) {
      await this.quarantine();
    }
    return value;
  }

  async write(value: T): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const tempPath = join(this.directory, `.${this.fileName}.${process.pid}.${tempCounter++}.tmp`);
    await writeFile(tempPath, JSON.stringify(value, null, 2), 'utf8');
    try {
      await this.renameWithRetry(tempPath, this.path);
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
  }

  /** Reads, transforms and writes back. Not a lock: concurrent windows coordinate via the lock file. */
  async update(transform: (current: T | undefined) => T): Promise<T> {
    const next = transform(await this.read());
    await this.write(next);
    return next;
  }

  async delete(): Promise<void> {
    await rm(this.path, { force: true });
  }

  private async renameWithRetry(from: string, to: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(from, to);
        return;
      } catch (error) {
        if (attempt >= this.renameRetries || !RETRYABLE_RENAME_CODES.has(errorCode(error) ?? '')) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, this.renameRetryDelayMs * (attempt + 1)));
      }
    }
  }

  private async quarantine(): Promise<void> {
    try {
      await rename(this.path, `${this.path}.corrupt-${Date.now()}`);
    } catch {
      // Another window may have already moved or replaced it.
    }
  }
}
