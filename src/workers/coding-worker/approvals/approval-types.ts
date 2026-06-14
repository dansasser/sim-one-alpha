export type CodingApprovalActionType =
  | 'file.edit'
  | 'shell.execute'
  | 'repo.clone'
  | 'repo.register'
  | 'repo.branch.create'
  | 'repo.worktree.create'
  | 'repo.fetch'
  | 'repo.sync'
  | 'git.commit'
  | 'git.push'
  | 'github.comment'
  | 'github.pr.create'
  | 'github.pr.update'
  | 'github.pr.ready'
  | 'github.issue.update'
  | 'github.review-thread.update'
  | 'github.branch_from_pr'
  | 'github.review_comment'
  | 'github.check.rerun'
  | 'github.fork_repo';

export type CodingApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';

export type CodingApprovalMetadata = Record<string, string | number | boolean>;

export interface CodingApprovalPrincipal {
  id: string;
  roles: string[];
}

export interface CodingApprovalRequest {
  id: string;
  dedupeKey: string;
  taskId: string;
  actionType: CodingApprovalActionType;
  summary: string;
  reason: string;
  risk: string;
  target?: string;
  requestedBy?: string;
  createdAt: string;
  expiresAt?: string;
  metadata?: CodingApprovalMetadata;
}

export interface CodingApprovalDecision {
  requestId: string;
  approved: boolean;
  decidedBy: string;
  decidedAt: string;
  reason?: string;
}

export interface CodingApprovalEvaluation {
  allowed: boolean;
  requiresApproval: boolean;
  reason: string;
  status: CodingApprovalStatus;
}

export interface CodingApprovalRecord {
  request: CodingApprovalRequest;
  status: CodingApprovalStatus;
  decision?: CodingApprovalDecision;
  updatedAt: string;
}

