import { useEffect, useRef, useState } from 'react';
import type { ApprovalClient, ApprovalRequest } from '../lib/approvalClient.js';

export interface UsePendingApprovalsResult {
  pending: ApprovalRequest[];
  loading: boolean;
  error: Error | undefined;
  refresh: () => void;
  configured: boolean;
}

const POLL_INTERVAL_MS = 3000;

export function usePendingApprovals(client: ApprovalClient | undefined): UsePendingApprovalsResult {
  const [pending, setPending] = useState<ApprovalRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | undefined>();
  const [configured, setConfigured] = useState(true);
  const clientRef = useRef(client);
  clientRef.current = client;
  const inProgressRef = useRef(false);

  const refresh = async () => {
    const c = clientRef.current;
    if (!c || inProgressRef.current) return;
    inProgressRef.current = true;
    setLoading(true);
    try {
      const result = await c.listPending();
      setPending(result);
      setConfigured(c.isConfigured());
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
      inProgressRef.current = false;
    }
  };

  useEffect(() => {
    if (!client) return;
    refresh();
    const interval = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [client]);

  return { pending, loading, error, refresh, configured };
}