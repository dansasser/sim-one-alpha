import { randomUUID } from 'node:crypto';
import type { CodingSubagentKind } from '../types.js';

export const codingWorkerLeadHarnessName = 'gorombo-coding-worker';

export interface CodingWorkerSessionPlan {
  taskId: string;
  leadSessionName: string;
  childSessions: Record<CodingSubagentKind, string>;
}

export function createCodingWorkerSessionPlan(taskId: string, sessionId?: string): CodingWorkerSessionPlan {
  const stableTaskId = sanitizeSessionPart(taskId);
  const stableSessionId = sessionId === undefined ? undefined : sanitizeSessionPart(sessionId);
  const hasEmptyInput = !stableTaskId || (sessionId !== undefined && !stableSessionId);
  const base = hasEmptyInput
    ? createUniqueSessionBase(stableTaskId)
    : stableSessionId ?? `coding-${stableTaskId}`;

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

function sanitizeSessionPart(value: string): string | undefined {
  const sanitized = value.trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '');
  return sanitized || undefined;
}

function createUniqueSessionBase(stableTaskId: string | undefined): string {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  return stableTaskId ? `coding-${stableTaskId}-${suffix}` : `coding-task-${suffix}`;
}
