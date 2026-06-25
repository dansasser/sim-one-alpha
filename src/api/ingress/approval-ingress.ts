import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { lock } from 'proper-lockfile';
import type { CodingApprovalService } from '../../engine/workers/coding-worker/approvals/approval-service.js';
import type { CodingApprovalRecord } from '../../engine/workers/coding-worker/approvals/approval-types.js';
import type {
  ApprovalBinding,
  ApprovalBindingFilter,
  ApprovalDecisionInput,
  ApprovalIngress,
  ApprovalRecordFilter,
} from '../../api/ingress/approval-types.js';

export interface ApprovalBindingStore {
  upsertBinding(binding: ApprovalBinding): Promise<void>;
  listBindings(filter?: ApprovalBindingFilter): Promise<ApprovalBinding[]>;
  getBinding(requestId: string): Promise<ApprovalBinding | undefined>;
}

export interface ApprovalIngressOptions {
  approvalService: CodingApprovalService;
  bindingStore?: ApprovalBindingStore;
}

export function createApprovalIngress(options: ApprovalIngressOptions): ApprovalIngress {
  const approvalService = options.approvalService;
  const bindingStore = options.bindingStore ?? new InMemoryApprovalBindingStore();

  return {
    approvalService,
    async listPendingApprovals(filter: ApprovalRecordFilter = {}): Promise<CodingApprovalRecord[]> {
      const records = await approvalService.listRecords(filter.taskId);
      const pending = records.filter((record) => record.status === 'pending');

      if (filter.connector || filter.actorId || filter.conversationId) {
        const bindings = await bindingStore.listBindings({
          connector: filter.connector,
          actorId: filter.actorId,
          conversationId: filter.conversationId,
        });
        const requestIds = new Set(bindings.map((binding) => binding.requestId));
        return pending.filter((record) => requestIds.has(record.request.id));
      }

      return pending;
    },

    async getApprovalRequest(requestId: string) {
      return approvalService.getRecord(requestId);
    },

    async recordApprovalDecision(input: ApprovalDecisionInput) {
      return approvalService.recordDecision({
        requestId: input.requestId,
        approved: input.approved,
        decidedBy: input.decidedBy,
        reason: input.reason,
        principal: input.principal,
      });
    },

    async bindApprovalRequest(input: ApprovalBinding) {
      const binding: ApprovalBinding = {
        ...input,
        createdAt: input.createdAt ?? new Date().toISOString(),
      };
      await bindingStore.upsertBinding(binding);
      return binding;
    },

    async listBindings(filter: ApprovalBindingFilter = {}) {
      return bindingStore.listBindings(filter);
    },
  };
}

export class InMemoryApprovalBindingStore implements ApprovalBindingStore {
  readonly #bindings = new Map<string, ApprovalBinding>();

  async upsertBinding(binding: ApprovalBinding): Promise<void> {
    this.#bindings.set(binding.requestId, { ...binding });
  }

  async listBindings(filter: ApprovalBindingFilter = {}): Promise<ApprovalBinding[]> {
    return [...this.#bindings.values()].filter((binding) => {
      if (filter.requestId && binding.requestId !== filter.requestId) return false;
      if (filter.connector && binding.connector !== filter.connector) return false;
      if (filter.actorId && binding.actorId !== filter.actorId) return false;
      if (filter.conversationId && binding.conversationId !== filter.conversationId) return false;
      return true;
    });
  }

  async getBinding(requestId: string): Promise<ApprovalBinding | undefined> {
    const binding = this.#bindings.get(requestId);
    return binding ? { ...binding } : undefined;
  }
}

export function createFileApprovalBindingStore(approvalRoot: string): ApprovalBindingStore {
  return new JsonFileApprovalBindingStore(join(approvalRoot, 'bindings.json'));
}

class JsonFileApprovalBindingStore implements ApprovalBindingStore {
  constructor(private readonly filePath: string) {}

  async upsertBinding(binding: ApprovalBinding): Promise<void> {
    return this.#withFileLock(async () => {
      const bindings = await this.readBindings();
      const index = bindings.findIndex((entry) => entry.requestId === binding.requestId);
      if (index >= 0) {
        bindings[index] = cloneBinding(binding);
      } else {
        bindings.push(cloneBinding(binding));
      }
      await this.writeBindings(bindings);
    });
  }

  async listBindings(filter: ApprovalBindingFilter = {}): Promise<ApprovalBinding[]> {
    return this.#withFileLock(async () => {
      return (await this.readBindings()).filter((binding) => {
        if (filter.requestId && binding.requestId !== filter.requestId) return false;
        if (filter.connector && binding.connector !== filter.connector) return false;
        if (filter.actorId && binding.actorId !== filter.actorId) return false;
        if (filter.conversationId && binding.conversationId !== filter.conversationId) return false;
        return true;
      });
    });
  }

  async getBinding(requestId: string): Promise<ApprovalBinding | undefined> {
    return this.#withFileLock(async () => {
      const binding = (await this.readBindings()).find((entry) => entry.requestId === requestId);
      return binding ? cloneBinding(binding) : undefined;
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

  private async readBindings(): Promise<ApprovalBinding[]> {
    try {
      const data = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown;
      if (!Array.isArray(data)) {
        return [];
      }
      return data.filter(isApprovalBinding).map((binding) => cloneBinding(binding));
    } catch (error) {
      if (isMissingFileError(error)) {
        return [];
      }
      throw error;
    }
  }

  private async writeBindings(bindings: ApprovalBinding[]): Promise<void> {
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    const tempPath = `${this.filePath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const handle = await open(tempPath, 'w', 0o644);
    try {
      await handle.writeFile(`${JSON.stringify(bindings, null, 2)}\n`, 'utf8');
      await handle.sync();
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      await handle.close();
    }
    await rename(tempPath, this.filePath);
  }
}

function isApprovalBinding(value: unknown): value is ApprovalBinding {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const binding = value as Partial<ApprovalBinding>;
  return Boolean(
    typeof binding.requestId === 'string' &&
typeof binding.connector === 'string' &&
    typeof binding.createdAt === 'string',
  );
}

function cloneBinding(binding: ApprovalBinding): ApprovalBinding {
  return { ...binding };
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT',
  );
}
