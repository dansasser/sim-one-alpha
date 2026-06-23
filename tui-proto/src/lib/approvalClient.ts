export interface ApprovalRequest {
  requestId: string;
  status: 'pending' | 'approved' | 'denied';
  taskType: string;
  description: string;
  actorId?: string;
  conversationId?: string;
  connector?: string;
  createdAt: string;
}

export interface ApprovalDecision {
  requestId: string;
  approved: boolean;
  decidedBy: string;
  reason?: string;
}

export interface ApprovalClient {
  listPending(): Promise<ApprovalRequest[]>;
  decide(decision: ApprovalDecision): Promise<unknown>;
  isConfigured(): boolean;
}

export function createApprovalClient(baseUrl: string, token: string): ApprovalClient {
  const headers: Record<string, string> = {
    'x-api-secret': token,
    'content-type': 'application/json',
  };

  let configured: boolean | undefined;

  return {
    async listPending() {
      const resp = await fetch(`${baseUrl}/api/approvals/pending`, { headers });
      if (resp.status === 400 || resp.status === 500) {
        configured = false;
        return [];
      }
      if (!resp.ok) {
        throw new Error(`Approvals list failed: ${resp.status}`);
      }
      configured = true;
      const data = await resp.json();
      return Array.isArray(data) ? data : [];
    },

    async decide(decision: ApprovalDecision) {
      const resp = await fetch(`${baseUrl}/api/approvals/${decision.requestId}/decision`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          approved: decision.approved,
          decidedBy: decision.decidedBy,
          reason: decision.reason,
        }),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => 'unknown error');
        throw new Error(`Approval decision failed: ${resp.status} ${text}`);
      }
      return resp.json();
    },

    isConfigured() {
      return configured !== false;
    },
  };
}