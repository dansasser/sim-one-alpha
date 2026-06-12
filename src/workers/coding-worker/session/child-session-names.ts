import type { CodingSubagentKind } from '../types.js';

export const codingWorkerLeadHarnessName = 'gorombo-coding-worker';

export interface CodingWorkerSessionPlan {
  taskId: string;
  leadSessionName: string;
  childSessions: Record<CodingSubagentKind, string>;
}

export function createCodingWorkerSessionPlan(taskId: string, sessionId?: string): CodingWorkerSessionPlan {
  const stableTaskId = sanitizeSessionPart(taskId);
  const base = sanitizeSessionPart(sessionId ?? `coding-${stableTaskId}`);

  return {
    taskId,
    leadSessionName: base,
    childSessions: {
      triage: `${base}:triage`,
      implementer: `${base}:implementer`,
      'test-debug': `${base}:test-debug`,
      'code-review': `${base}:code-review`,
      github: `${base}:github`,
    },
  };
}

function sanitizeSessionPart(value: string): string {
  const sanitized = value.trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '');
  return sanitized || 'coding-task';
}

