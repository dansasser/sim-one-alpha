import type {
  CodingApprovalActionType,
  CodingApprovalDecision,
  CodingApprovalEvaluation,
  CodingApprovalRequest,
} from './approval-types.js';

const defaultApprovalRequiredActions = new Set<CodingApprovalActionType>([
  'git.commit',
  'git.push',
  'github.comment',
  'github.pr.create',
  'github.pr.update',
  'github.review-thread.update',
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
    };
  }

  if (!decision) {
    return {
      allowed: false,
      requiresApproval: true,
      reason: 'Action requires explicit approval before execution.',
    };
  }

  if (decision.requestId !== request.id) {
    return {
      allowed: false,
      requiresApproval: true,
      reason: 'Approval decision does not match this request.',
    };
  }

  return {
    allowed: decision.approved,
    requiresApproval: true,
    reason: decision.approved ? 'Action approved.' : decision.reason ?? 'Action denied.',
  };
}

export function createCodingApprovalRequest(input: Omit<CodingApprovalRequest, 'id'> & { id?: string }): CodingApprovalRequest {
  return {
    ...input,
    id: input.id ?? `${input.taskId}:${input.actionType}`,
  };
}

