import {
  createCodingApprovalRequest,
  evaluateCodingApproval,
} from '../../../../engine/workers/coding-worker/approvals/approval-policy.js';
import type { CodingApprovalActionType, CodingApprovalDecision } from '../../../../engine/workers/coding-worker/approvals/approval-types.js';

export function evaluateGithubSideEffect(input: {
  taskId: string;
  actionType: Extract<
    CodingApprovalActionType,
    'git.push' | 'github.comment' | 'github.pr.create' | 'github.pr.update' | 'github.review-thread.update'
  >;
  summary: string;
  reason: string;
  risk: string;
  decision?: CodingApprovalDecision;
}) {
  const request = createCodingApprovalRequest(input);
  return {
    request,
    evaluation: evaluateCodingApproval(request, input.decision),
  };
}

