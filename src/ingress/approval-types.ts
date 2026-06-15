import type { CodingApprovalService } from '../workers/coding-worker/approvals/approval-service.js';
import type {
  CodingApprovalDecision,
  CodingApprovalRecord,
} from '../workers/coding-worker/approvals/approval-types.js';

export interface ApprovalBinding {
  requestId: string;
  connector: string;
  actorId?: string;
  conversationId?: string;
  createdAt: string;
}

export interface ApprovalBindingFilter {
  requestId?: string;
  connector?: string;
  actorId?: string;
  conversationId?: string;
}

export interface ApprovalRecordFilter {
  taskId?: string;
  actorId?: string;
  conversationId?: string;
  connector?: string;
}

export interface ApprovalDecisionInput {
  requestId: string;
  approved: boolean;
  decidedBy: string;
  reason?: string;
  principal: {
    id: string;
    roles: string[];
  };
}

export interface ApprovalIngress {
  approvalService: CodingApprovalService;
  listPendingApprovals(filter?: ApprovalRecordFilter): Promise<CodingApprovalRecord[]>;
  getApprovalRequest(requestId: string): Promise<CodingApprovalRecord | undefined>;
  recordApprovalDecision(input: ApprovalDecisionInput): Promise<CodingApprovalDecision>;
  bindApprovalRequest(input: ApprovalBinding): Promise<ApprovalBinding>;
  listBindings(filter?: ApprovalBindingFilter): Promise<ApprovalBinding[]>;
}
