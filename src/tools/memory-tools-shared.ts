import { goromboPersistenceRuntime } from '../db.js';
import { getStructuredMemoryEngine } from '../memory/structured-memory-runtime.js';
import type { MemoryEngine } from '../memory/memory-engine.js';
import type { MemoryRecordScope } from '../types/memory.js';
import type { NormalizedMessageEvent } from '../types/index.js';

/** Trust boundary: every mutating memory tool requires a trusted persisted event. */
export function getTrustedMemoryEvent(eventId: unknown): NormalizedMessageEvent {
  const event = goromboPersistenceRuntime.sessionDatabase.getNormalizedMessageEvent(String(eventId));
  if (!event) {
    throw new Error('memory tool requires a trusted eventId persisted by chat ingress.');
  }
  return event;
}

/** Derive the structured-memory scope from a trusted event. Never from the model. */
export function deriveMemoryScope(event: NormalizedMessageEvent): MemoryRecordScope {
  const scope: MemoryRecordScope = {
    actorId: event.actor.id,
    conversationId: event.conversation.id,
  };
  if (event.context?.projectId) {
    scope.projectId = event.context.projectId;
  }
  if (event.conversation.threadId) {
    scope.threadId = event.conversation.threadId;
  }
  return scope;
}

/** Resolve the shared structured-memory engine (lazy singleton). */
export function getMemoryEngine(): Promise<MemoryEngine> {
  return getStructuredMemoryEngine();
}

export interface MemoryToolAudit {
  updatedBy: string;
  runId?: string;
}

/** Audit fields for orchestrator-owned memory writes. */
export function orchestratorAudit(): MemoryToolAudit {
  return { updatedBy: 'orchestrator' };
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
}
