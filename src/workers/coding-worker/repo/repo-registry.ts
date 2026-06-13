import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface CodingRegisteredRepo {
  slug: string;
  repoRelativePath: string;
  repoPath: string;
  remoteUrl?: string;
  owner?: string;
  repo?: string;
  defaultBranch?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CodingRepoRegistry {
  get(slug: string): Promise<CodingRegisteredRepo | undefined>;
  list(): Promise<CodingRegisteredRepo[]>;
  upsert(repo: CodingRegisteredRepo): Promise<void>;
}

export class InMemoryCodingRepoRegistry implements CodingRepoRegistry {
  readonly #records = new Map<string, CodingRegisteredRepo>();

  async get(slug: string): Promise<CodingRegisteredRepo | undefined> {
    const record = this.#records.get(slug);
    return record ? cloneRepo(record) : undefined;
  }

  async list(): Promise<CodingRegisteredRepo[]> {
    return [...this.#records.values()].map((record) => cloneRepo(record));
  }

  async upsert(repo: CodingRegisteredRepo): Promise<void> {
    this.#records.set(repo.slug, cloneRepo(repo));
  }
}

const fileMutexRegistry = new Map<string, AsyncMutex>();

export class JsonFileCodingRepoRegistry implements CodingRepoRegistry {
  constructor(private readonly filePath: string) {}

  static atWorkspaceRoot(workspaceRoot: string): JsonFileCodingRepoRegistry {
    return new JsonFileCodingRepoRegistry(
      join(workspaceRoot, '.gorombo', 'coding-worker', 'repos.json'),
    );
  }

  async get(slug: string): Promise<CodingRegisteredRepo | undefined> {
    return this.#withFileLock(async () => {
      const record = (await this.readRecords()).find((entry) => entry.slug === slug);
      return record ? cloneRepo(record) : undefined;
    });
  }

  async list(): Promise<CodingRegisteredRepo[]> {
    return this.#withFileLock(async () => {
      return (await this.readRecords()).map((record) => cloneRepo(record));
    });
  }

  async upsert(repo: CodingRegisteredRepo): Promise<void> {
    return this.#withFileLock(async () => {
      const records = await this.readRecords();
      const index = records.findIndex((entry) => entry.slug === repo.slug);
      const next = cloneRepo(repo);
      if (index >= 0) {
        records[index] = next;
      } else {
        records.push(next);
      }
      await this.writeRecords(records);
    });
  }

  async #withFileLock<T>(job: () => Promise<T>): Promise<T> {
    const mutex = getMutexForPath(this.filePath);
    return mutex(job);
  }

  private async readRecords(): Promise<CodingRegisteredRepo[]> {
    try {
      const data = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown;
      if (!Array.isArray(data)) {
        return [];
      }
      return data.filter(isRegisteredRepo).map((record) => cloneRepo(record));
    } catch (error) {
      if (isMissingFileError(error)) {
        return [];
      }
      throw error;
    }
  }

  private async writeRecords(records: CodingRegisteredRepo[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  }
}

function getMutexForPath(path: string): AsyncMutex {
  let mutex = fileMutexRegistry.get(path);
  if (!mutex) {
    mutex = createAsyncMutex();
    fileMutexRegistry.set(path, mutex);
  }
  return mutex;
}

type AsyncMutex = <T>(job: () => Promise<T>) => Promise<T>;

function createAsyncMutex(): AsyncMutex {
  let tail: Promise<unknown> = Promise.resolve();
  return async (job) => {
    const next = tail.then(async () => job());
    tail = next.catch(() => undefined);
    return next;
  };
}

export function createRegisteredRepo(input: {
  slug: string;
  repoRelativePath: string;
  repoPath: string;
  remoteUrl?: string;
  owner?: string;
  repo?: string;
  defaultBranch?: string;
  existing?: CodingRegisteredRepo;
  now?: string;
}): CodingRegisteredRepo {
  const now = input.now ?? new Date().toISOString();
  return {
    slug: input.slug,
    repoRelativePath: input.repoRelativePath,
    repoPath: input.repoPath,
    ...(input.remoteUrl ? { remoteUrl: input.remoteUrl } : {}),
    ...(input.owner ? { owner: input.owner } : {}),
    ...(input.repo ? { repo: input.repo } : {}),
    ...(input.defaultBranch ? { defaultBranch: input.defaultBranch } : {}),
    createdAt: input.existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function isRegisteredRepo(value: unknown): value is CodingRegisteredRepo {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const repo = value as Partial<CodingRegisteredRepo>;
  return Boolean(
    typeof repo.slug === 'string' &&
      typeof repo.repoRelativePath === 'string' &&
      typeof repo.repoPath === 'string' &&
      typeof repo.createdAt === 'string' &&
      typeof repo.updatedAt === 'string',
  );
}

function cloneRepo(repo: CodingRegisteredRepo): CodingRegisteredRepo {
  return { ...repo };
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT',
  );
}
