export type CodingApprovalActionType =
  | 'file.edit'
  | 'shell.execute'
  | 'git.commit'
  | 'git.push'
  | 'github.comment'
  | 'github.pr.create'
  | 'github.pr.update'
  | 'github.review-thread.update';

export interface CodingApprovalRequest {
  id: string;
  taskId: string;
  actionType: CodingApprovalActionType;
  summary: string;
  reason: string;
  risk: string;
}

export interface CodingApprovalDecision {
  requestId: string;
  approved: boolean;
  decidedBy?: string;
  reason?: string;
}

export interface CodingApprovalEvaluation {
  allowed: boolean;
  requiresApproval: boolean;
  reason: string;
}

