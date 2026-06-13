import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { lock } from 'proper-lockfile';
import type {
  CodingApprovalDecision,
  CodingApprovalRecord,
  CodingApprovalRequest,
  CodingApprovalStatus,
} from './approval-types.js';

export interface CodingApprovalStore {
  getRecord(requestId: string): Promise<CodingApprovalRecord | undefined>;
  upsertRecord(record: CodingApprovalRecord): Promise<void>;
  listRecords(taskId?: string): Promise<CodingApprovalRecord[]>;
}

export class InMemoryCodingApprovalStore implements CodingApprovalStore {
  readonly #records = new Map<string, CodingApprovalRecord>();

  async getRecord(requestId: string): Promise<CodingApprovalRecord | undefined> {
    const record = this.#records.get(requestId);
    return record ? cloneRecord(record) : undefined;
  }

  async upsertRecord(record: CodingApprovalRecord): Promise<void> {
    this.#records.set(record.request.id, cloneRecord(record));
  }

  async listRecords(taskId?: string): Promise<CodingApprovalRecord[]> {
    const records = [...this.#records.values()];
    return records
      .filter((record) => !taskId || record.request.taskId === taskId)
      .map((record) => cloneRecord(record));
  }
}

export class JsonFileCodingApprovalStore implements CodingApprovalStore {
  constructor(private readonly filePath: string) {}

  static atWorkspaceRoot(workspaceRoot: string): JsonFileCodingApprovalStore {
    return new JsonFileCodingApprovalStore(
      join(workspaceRoot, '.gorombo', 'coding-worker', 'approvals.json'),
    );
  }

  async getRecord(requestId: string): Promise<CodingApprovalRecord | undefined> {
    return this.#withFileLock(async () => {
      const record = (await this.readRecords()).find((entry) => entry.request.id === requestId);
      return record ? cloneRecord(record) : undefined;
    });
  }

  async upsertRecord(record: CodingApprovalRecord): Promise<void> {
    return this.#withFileLock(async () => {
      const records = await this.readRecords();
      const index = records.findIndex((entry) => entry.request.id === record.request.id);
      if (index >= 0) {
        records[index] = cloneRecord(record);
      } else {
        records.push(cloneRecord(record));
      }
      await this.writeRecords(records);
    });
  }

  async listRecords(taskId?: string): Promise<CodingApprovalRecord[]> {
    return this.#withFileLock(async () => {
      return (await this.readRecords())
        .filter((record) => !taskId || record.request.taskId === taskId)
        .map((record) => cloneRecord(record));
    });
  }

  async #withFileLock<T>(job: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const release = await lock(this.filePath, {
      realpath: false,
      stale: 5000,
      update: 1000,
      retries: {
        retries: 10,
        factor: 2,
        minTimeout: 20,
        maxTimeout: 1000,
      },
    });
    try {
      return await job();
    } finally {
      await release();
    }
  }

  private async readRecords(): Promise<CodingApprovalRecord[]> {
    try {
      const data = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown;
      if (!Array.isArray(data)) {
        return [];
      }
      return data.filter(isApprovalRecord).map((record) => cloneRecord(record));
    } catch (error) {
      if (isMissingFileError(error)) {
        return [];
      }
      throw error;
    }
  }

  private async writeRecords(records: CodingApprovalRecord[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  }
}

function isApprovalRecord(value: unknown): value is CodingApprovalRecord {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Partial<CodingApprovalRecord>;
  return Boolean(
    record.request &&
      typeof record.request.id === 'string' &&
      typeof record.request.taskId === 'string' &&
      typeof record.request.actionType === 'string' &&
      isApprovalStatus(record.status) &&
      typeof record.updatedAt === 'string',
  );
}

function isApprovalStatus(value: unknown): value is CodingApprovalStatus {
  return (
    value === 'pending' ||
    value === 'approved' ||
    value === 'denied' ||
    value === 'expired' ||
    value === 'cancelled'
  );
}

function cloneRecord(record: CodingApprovalRecord): CodingApprovalRecord;
function cloneRecord(record: CodingApprovalRecord): CodingApprovalRecord {
  return {
    request: {
      ...record.request,
      ...(record.request.metadata ? { metadata: { ...record.request.metadata } } : {}),
    },
    status: record.status,
    ...(record.decision ? { decision: cloneDecision(record.decision) } : {}),
    updatedAt: record.updatedAt,
  };
}

function cloneDecision(decision: CodingApprovalDecision): CodingApprovalDecision {
  return { ...decision };
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT',
  );
}
