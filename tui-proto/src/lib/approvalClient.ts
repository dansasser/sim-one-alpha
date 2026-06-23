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

const FETCH_TIMEOUT_MS = 10000;

function fetchWithTimeout(url: string, options: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('timeout'), FETCH_TIMEOUT_MS);
  return fetch(url, { ...options, signal: controller.signal }).finally(() =>
    clearTimeout(timeout),
  );
}

export function createApprovalClient(baseUrl: string, token: string): ApprovalClient {
  const headers: Record<string, string> = {
    'x-api-secret': token,
    'content-type': 'application/json',
  };

  let configured: boolean | undefined;

  return {
    async listPending() {
      const resp = await fetchWithTimeout(`${baseUrl}/api/approvals/pending`, { headers });
      if (resp.status === 400) {
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
      const resp = await fetchWithTimeout(`${baseUrl}/api/approvals/${decision.requestId}/decision`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          approved: decision.approved,
          decidedBy: decision.decidedBy,
          reason: decision.reason,
        }),
      });
      if (!resp.ok) {
        throw new Error(`Approval decision failed: ${resp.status}`);
      }
      return resp.json();
    },

    isConfigured() {
      return configured !== false;
    },
  };
}