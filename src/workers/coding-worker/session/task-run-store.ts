import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CodingWorkerEvent } from '../events/coding-worker-events.js';
import type {
  CodingPlanItem,
  CodingSubagentKind,
  CodingVerificationEvidence,
} from '../types.js';
import type { CodingWorkerSessionPlan } from './child-session-names.js';

export type CodingTaskRunStatus =
  | 'accepted'
  | 'triaging'
  | 'implementing'
  | 'testing'
  | 'reviewing'
  | 'github'
  | 'awaiting_approval'
  | 'completed'
  | 'blocked'
  | 'failed';

export interface CodingTaskRunRecord {
  taskId: string;
  status: CodingTaskRunStatus;
  sessionPlan: CodingWorkerSessionPlan;
  plan: CodingPlanItem[];
  events: CodingWorkerEvent[];
  verificationEvidence: CodingVerificationEvidence[];
  createdAt: string;
  updatedAt: string;
}

export interface CodingTaskRunStore {
  get(taskId: string): Promise<CodingTaskRunRecord | undefined>;
  upsert(record: CodingTaskRunRecord): Promise<void>;
  list(): Promise<CodingTaskRunRecord[]>;
}

export class InMemoryCodingTaskRunStore implements CodingTaskRunStore {
  readonly #records = new Map<string, CodingTaskRunRecord>();

  async get(taskId: string): Promise<CodingTaskRunRecord | undefined> {
    const record = this.#records.get(taskId);
    return record ? cloneRecord(record) : undefined;
  }

  async upsert(record: CodingTaskRunRecord): Promise<void> {
    this.#records.set(record.taskId, cloneRecord(record));
  }

  async list(): Promise<CodingTaskRunRecord[]> {
    return [...this.#records.values()].map((record) => cloneRecord(record));
  }
}

export class JsonFileCodingTaskRunStore implements CodingTaskRunStore {
  constructor(private readonly filePath: string) {}
  readonly #lock = createAsyncMutex();

  static atWorkspaceRoot(workspaceRoot: string): JsonFileCodingTaskRunStore {
    return new JsonFileCodingTaskRunStore(
      join(workspaceRoot, '.gorombo', 'coding-worker', 'task-runs.json'),
    );
  }

  async get(taskId: string): Promise<CodingTaskRunRecord | undefined> {
    const record = (await this.readRecords()).find((entry) => entry.taskId === taskId);
    return record ? cloneRecord(record) : undefined;
  }

  async upsert(record: CodingTaskRunRecord): Promise<void> {
    await this.#lock(async () => {
      const records = await this.readRecords();
      const index = records.findIndex((entry) => entry.taskId === record.taskId);
      if (index >= 0) {
        records[index] = cloneRecord(record);
      } else {
        records.push(cloneRecord(record));
      }
      await this.writeRecords(records);
    });
  }

  async list(): Promise<CodingTaskRunRecord[]> {
    return (await this.readRecords()).map((record) => cloneRecord(record));
  }

  private async readRecords(): Promise<CodingTaskRunRecord[]> {
    try {
      const data = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown;
      if (!Array.isArray(data)) {
        return [];
      }
      return data.filter(isTaskRunRecord).map((record) => cloneRecord(record));
    } catch (error) {
      if (isMissingFileError(error)) {
        return [];
      }
      throw error;
    }
  }

  private async writeRecords(records: CodingTaskRunRecord[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  }
}

function createAsyncMutex(): <T>(job: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return async (job) => {
    const next = tail.then(async () => job());
    tail = next.catch(() => undefined);
    return next;
  };
}

export function statusForCodingSubagent(subagent: CodingSubagentKind): CodingTaskRunStatus {
  switch (subagent) {
    case 'triage':
      return 'triaging';
    case 'implementer':
      return 'implementing';
    case 'test-debug':
      return 'testing';
    case 'code-review':
      return 'reviewing';
    case 'github':
      return 'github';
    default: {
      const _exhaustive: never = subagent;
      throw new Error(`Unexpected coding subagent kind: ${String(_exhaustive)}`);
    }
  }
}

function isTaskRunRecord(value: unknown): value is CodingTaskRunRecord {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Partial<CodingTaskRunRecord>;
  return Boolean(
    typeof record.taskId === 'string' &&
      isTaskRunStatus(record.status) &&
      record.sessionPlan &&
      Array.isArray(record.plan) &&
      Array.isArray(record.events) &&
      Array.isArray(record.verificationEvidence) &&
      typeof record.createdAt === 'string' &&
      typeof record.updatedAt === 'string',
  );
}

function isTaskRunStatus(value: unknown): value is CodingTaskRunStatus {
  return (
    value === 'accepted' ||
    value === 'triaging' ||
    value === 'implementing' ||
    value === 'testing' ||
    value === 'reviewing' ||
    value === 'github' ||
    value === 'awaiting_approval' ||
    value === 'completed' ||
    value === 'blocked' ||
    value === 'failed'
  );
}

function cloneRecord(record: CodingTaskRunRecord): CodingTaskRunRecord;
function cloneRecord(record: CodingTaskRunRecord): CodingTaskRunRecord {
  return {
    taskId: record.taskId,
    status: record.status,
    sessionPlan: {
      ...record.sessionPlan,
      childSessions: { ...record.sessionPlan.childSessions },
    },
    plan: record.plan.map((item) => ({ ...item })),
    events: record.events.map((event) => ({
      ...event,
      ...(event.evidence ? { evidence: [...event.evidence] } : {}),
    })),
    verificationEvidence: record.verificationEvidence.map((item) => ({ ...item })),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT',
  );
}
