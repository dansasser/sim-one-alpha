import {
  createCodingApprovalRequest,
  evaluateCodingApproval,
} from './approval-policy.js';
import {
  InMemoryCodingApprovalStore,
  JsonFileCodingApprovalStore,
  type CodingApprovalStore,
} from './approval-store.js';
import type {
  CodingApprovalDecision,
  CodingApprovalEvaluation,
  CodingApprovalRecord,
  CodingApprovalRequest,
} from './approval-types.js';

export type CreateCodingApprovalRequestInput = Parameters<typeof createCodingApprovalRequest>[0];

export interface RecordCodingApprovalDecisionInput {
  requestId: string;
  approved: boolean;
  decidedBy: string;
  reason?: string;
  decidedAt?: string;
  /**
   * Optional authenticated principal. When supplied, it must match decidedBy.
   * Callers should provide this from the transport/auth layer.
   */
  trustedActor?: string;
}

export interface CodingApprovalService {
  createRequest(input: CreateCodingApprovalRequestInput): Promise<CodingApprovalRequest>;
  getRecord(requestId: string): Promise<CodingApprovalRecord | undefined>;
  listRecords(taskId?: string): Promise<CodingApprovalRecord[]>;
  recordDecision(input: RecordCodingApprovalDecisionInput): Promise<CodingApprovalDecision>;
  cancelRequest(requestId: string, reason?: string): Promise<CodingApprovalRecord>;
  resolveDecision(request: CodingApprovalRequest): Promise<CodingApprovalDecision | undefined>;
  evaluateRequest(request: CodingApprovalRequest): Promise<CodingApprovalEvaluation>;
}

export function createInMemoryCodingApprovalService(
  store: CodingApprovalStore = new InMemoryCodingApprovalStore(),
): CodingApprovalService {
  return new DefaultCodingApprovalService(store);
}

export function createFileCodingApprovalService(workspaceRoot: string): CodingApprovalService {
  return new DefaultCodingApprovalService(JsonFileCodingApprovalStore.atWorkspaceRoot(workspaceRoot));
}

class DefaultCodingApprovalService implements CodingApprovalService {
  constructor(private readonly store: CodingApprovalStore) {}

  async createRequest(input: CreateCodingApprovalRequestInput): Promise<CodingApprovalRequest> {
    const request = createCodingApprovalRequest(input);
    const existing = await this.store.getRecord(request.id);
    if (existing) {
      if (isExpired(existing.request) && existing.status === 'pending') {
        await this.store.upsertRecord({
          ...existing,
          status: 'expired',
          updatedAt: new Date().toISOString(),
        });
      }
      return existing.request;
    }

    await this.store.upsertRecord({
      request,
      status: 'pending',
      updatedAt: request.createdAt,
    });
    return request;
  }

  async getRecord(requestId: string): Promise<CodingApprovalRecord | undefined> {
    const record = await this.store.getRecord(requestId);
    if (record?.status === 'pending' && isExpired(record.request)) {
      const expired = {
        ...record,
        status: 'expired' as const,
        updatedAt: new Date().toISOString(),
      };
      await this.store.upsertRecord(expired);
      return expired;
    }
    return record;
  }

  async listRecords(taskId?: string): Promise<CodingApprovalRecord[]> {
    const records = await this.store.listRecords(taskId);
    const now = new Date().toISOString();
    const normalized = await Promise.all(
      records.map(async (record) => {
        if (record.status === 'pending' && isExpired(record.request)) {
          const expired = { ...record, status: 'expired' as const, updatedAt: now };
          await this.store.upsertRecord(expired);
          return expired;
        }
        return record;
      }),
    );
    return normalized;
  }

  async recordDecision(input: RecordCodingApprovalDecisionInput): Promise<CodingApprovalDecision> {
    if (!input.decidedBy.trim()) {
      throw new Error('Approval decision requires a trusted decidedBy actor.');
    }
    if (input.trustedActor !== undefined && input.trustedActor !== input.decidedBy) {
      throw new Error('Approval decidedBy does not match the authenticated trusted actor.');
    }

    const record = await this.getRecord(input.requestId);
    if (!record) {
      throw new Error(`Approval request not found: ${input.requestId}`);
    }
    if (record.status !== 'pending') {
      throw new Error(`Approval request is not pending: ${record.status}`);
    }

    const decision: CodingApprovalDecision = {
      requestId: input.requestId,
      approved: input.approved,
      decidedBy: input.decidedBy,
      decidedAt: input.decidedAt ?? new Date().toISOString(),
      ...(input.reason ? { reason: input.reason } : {}),
    };
    await this.store.upsertRecord({
      request: record.request,
      status: decision.approved ? 'approved' : 'denied',
      decision,
      updatedAt: decision.decidedAt,
    });
    return decision;
  }

  async cancelRequest(requestId: string, reason?: string): Promise<CodingApprovalRecord> {
    const record = await this.getRecord(requestId);
    if (!record) {
      throw new Error(`Approval request not found: ${requestId}`);
    }
    if (record.status !== 'pending') {
      throw new Error(`Approval request is not pending: ${record.status}`);
    }
    const cancelled = {
      ...record,
      status: 'cancelled' as const,
      decision: {
        requestId,
        approved: false,
        decidedBy: 'system',
        decidedAt: new Date().toISOString(),
        reason: reason ?? 'Approval request cancelled.',
      },
      updatedAt: new Date().toISOString(),
    };
    await this.store.upsertRecord(cancelled);
    return cancelled;
  }

  async resolveDecision(request: CodingApprovalRequest): Promise<CodingApprovalDecision | undefined> {
    const record = await this.getRecord(request.id);
    return record?.decision;
  }

  async evaluateRequest(request: CodingApprovalRequest): Promise<CodingApprovalEvaluation> {
    const record = await this.store.getRecord(request.id);
    const persistedRequest = record?.request ?? request;
    return evaluateCodingApproval(persistedRequest, record?.decision);
  }
}

function isExpired(request: CodingApprovalRequest): boolean {
  if (!request.expiresAt) {
    return false;
  }
  const parsed = Date.parse(request.expiresAt);
  if (Number.isNaN(parsed)) {
    return true;
  }
  return parsed <= Date.now();
}
