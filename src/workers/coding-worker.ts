import type { WorkerRunRequest, WorkerRunResult } from '../types/index.js';

export async function runCodingWorkerPlaceholder(
  request: WorkerRunRequest,
): Promise<WorkerRunResult> {
  return {
    id: `coding-worker-result:${request.id}`,
    workerId: request.workerId,
    status: 'not_implemented',
    summary:
      'Coding worker runtime is intentionally placeholder-only in Phase 1. Future behavior will add plan, edit, test, debug loop, diff, and approval.',
    artifacts: [],
  };
}

