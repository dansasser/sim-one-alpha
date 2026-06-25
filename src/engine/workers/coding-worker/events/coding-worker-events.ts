import type { CodingPlanItem, CodingSubagentKind, CodingWorkerLoopStep } from '../../../../engine/workers/coding-worker/types.js';

export type CodingWorkerEventType =
  | 'coding.task.accepted'
  | 'coding.protocols.loaded'
  | 'coding.protocols.enforced'
  | 'coding.triage.started'
  | 'coding.triage.completed'
  | 'coding.implementer.started'
  | 'coding.implementer.completed'
  | 'coding.test-debug.started'
  | 'coding.test-debug.completed'
  | 'coding.review.started'
  | 'coding.review.completed'
  | 'coding.github.started'
  | 'coding.github.completed'
  | 'coding.plan.updated'
  | 'coding.replanned'
  | 'coding.subagent.started'
  | 'coding.subagent.completed'
  | 'coding.action.started'
  | 'coding.action.completed'
  | 'coding.verification.started'
  | 'coding.verification.completed'
  | 'coding.approval.requested'
  | 'coding.approval.completed'
  | 'coding.github.approval_requested'
  | 'coding.github.action_completed'
  | 'coding.completed'
  | 'coding.blocked'
  | 'coding.error';

export interface CodingWorkerEvent {
  type: CodingWorkerEventType;
  taskId: string;
  timestamp: string;
  subagent?: CodingSubagentKind;
  step?: CodingWorkerLoopStep;
  purpose?: string;
  summary?: string;
  evidence?: string[];
  decision?: string;
  nextAction?: string;
  risk?: string;
  approvalReason?: string;
  action?: string;
  command?: string;
  status?: string;
  plan?: CodingPlanItem[];
}

const forbiddenPublicTraceKeys = new Set([
  'thinking',
  'chainOfThought',
  'chain_of_thought',
  'rawThinking',
  'rawPrompt',
  'internalPrompt',
]);

export function createCodingWorkerEvent(
  input: Omit<CodingWorkerEvent, 'timestamp'> & { timestamp?: string },
): CodingWorkerEvent {
  const event = {
    ...input,
    timestamp: input.timestamp ?? new Date().toISOString(),
  };
  assertPublicCodingWorkerEvent(event);
  return event;
}

export function assertPublicCodingWorkerEvent(event: CodingWorkerEvent): void {
  const unsafeKey = findForbiddenKey(event);
  if (unsafeKey) {
    throw new Error(`Public coding-worker events must not expose private model context: ${unsafeKey}`);
  }
}

function findForbiddenKey(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  for (const [key, child] of Object.entries(value)) {
    if (forbiddenPublicTraceKeys.has(key)) {
      return key;
    }

    const nested = findForbiddenKey(child);
    if (nested) {
      return nested;
    }
  }

  return undefined;
}
