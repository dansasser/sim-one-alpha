import { createHash } from 'node:crypto';
import type {
  CodingApprovalActionType,
  CodingApprovalDecision,
  CodingApprovalEvaluation,
  CodingApprovalMetadata,
  CodingApprovalRequest,
} from './approval-types.js';

const defaultApprovalRequiredActions = new Set<CodingApprovalActionType>([
  'file.edit',
  'shell.execute',
  'repo.clone',
  'repo.register',
  'repo.branch.create',
  'repo.worktree.create',
  'repo.fetch',
  'repo.sync',
  'git.commit',
  'git.push',
  'github.comment',
  'github.pr.create',
  'github.pr.update',
  'github.pr.ready',
  'github.issue.update',
  'github.review-thread.update',
  'github.branch_from_pr',
  'github.review_comment',
  'github.check.rerun',
  'github.fork_repo',
]);

export function requiresCodingApproval(actionType: CodingApprovalActionType): boolean {
  return defaultApprovalRequiredActions.has(actionType);
}

export function evaluateCodingApproval(
  request: CodingApprovalRequest,
  decision?: CodingApprovalDecision,
): CodingApprovalEvaluation {
  const requiresApproval = requiresCodingApproval(request.actionType);

  if (!requiresApproval) {
    return {
      allowed: true,
      requiresApproval: false,
      reason: 'Action is allowed by the current local coding-worker policy.',
      status: 'approved',
    };
  }

  if (isExpired(request)) {
    return {
      allowed: false,
      requiresApproval: true,
      reason: 'Approval request has expired.',
      status: 'expired',
    };
  }

  if (!decision) {
    return {
      allowed: false,
      requiresApproval: true,
      reason: 'Action requires explicit approval before execution.',
      status: 'pending',
    };
  }

  if (decision.requestId !== request.id) {
    return {
      allowed: false,
      requiresApproval: true,
      reason: 'Approval decision does not match this request.',
      status: 'denied',
    };
  }

  return {
    allowed: decision.approved,
    requiresApproval: true,
    reason: decision.approved ? 'Action approved.' : decision.reason ?? 'Action denied.',
    status: decision.approved ? 'approved' : 'denied',
  };
}

export function createCodingApprovalRequest(
  input: Omit<CodingApprovalRequest, 'id' | 'dedupeKey' | 'createdAt'> & {
    id?: string;
    dedupeKey?: string;
    createdAt?: string;
  },
): CodingApprovalRequest {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const normalized = normalizeApprovalMetadata(input.metadata);
  const {
    metadata: _metadata,
    id: _id,
    dedupeKey: _dedupeKey,
    ...inputWithoutMetadata
  } = input;
  const dedupeKey =
    input.dedupeKey ??
    createDeterministicApprovalId({
      taskId: input.taskId,
      actionType: input.actionType,
      summary: input.summary,
      reason: input.reason,
      risk: input.risk,
      target: input.target,
      metadata: normalized,
    });
  return {
    ...inputWithoutMetadata,
    createdAt,
    ...(normalized ? { metadata: normalized } : {}),
    dedupeKey,
    id: input.id ?? `${dedupeKey}:${Date.now()}`,
  };
}

function createDeterministicApprovalId(input: {
  taskId: string;
  actionType: CodingApprovalActionType;
  summary: string;
  reason: string;
  risk: string;
  target?: string;
  metadata?: CodingApprovalMetadata;
}): string {
  const digest = createHash('sha256')
    .update(stableJson(input))
    .digest('hex')
    .slice(0, 16);
  return `${input.taskId}:${input.actionType}:${digest}`;
}

function stableJson(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return JSON.stringify(value);
  }

  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] = stableValue(record[key]);
  }
  return JSON.stringify(sorted);
}

function stableValue(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] = stableValue(record[key]);
  }
  return sorted;
}

function normalizeApprovalMetadata(
  metadata: CodingApprovalMetadata | undefined,
): CodingApprovalMetadata | undefined {
  if (!metadata) {
    return undefined;
  }

  const normalized: CodingApprovalMetadata = {};
  for (const key of Object.keys(metadata).sort()) {
    normalized[key] = metadata[key];
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function isExpired(request: CodingApprovalRequest): boolean {
  if (!request.expiresAt) {
    return false;
  }
  const parsed = Date.parse(request.expiresAt);
  if (Number.isNaN(parsed)) {
    return true;
  }
  return parsed <= Date.now();
}
