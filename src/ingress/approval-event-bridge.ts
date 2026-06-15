import type { NormalizedMessageEvent } from '../types/core.js';
import type { CodingApprovalActionType } from '../workers/coding-worker/approvals/approval-types.js';
import { createCodingWorkerEvent, type CodingWorkerEvent } from '../workers/coding-worker/events/coding-worker-events.js';
import type { CodingProgressReporter } from '../workers/coding-worker/events/progress-reporter.js';
import type { ApprovalIngress } from './approval-types.js';

export interface ApprovalEventBridgeContext {
  connector?: string;
  actorId?: string;
  conversationId?: string;
}

export type ApprovalEventBridge = (event: CodingWorkerEvent) => Promise<void>;

/**
 * Derives the bridge context from a normalized message event.
 *
 * The coding worker receives the original orchestrator event in
 * `CodingWorkerTaskRequest.event`. This helper turns its connector/actor/
 * conversation fields into the shape the approval event bridge needs to bind
 * approval requests to a human-facing surface.
 */
export function approvalEventBridgeContextFromEvent(
  event?: NormalizedMessageEvent,
): ApprovalEventBridgeContext {
  if (!event) {
    return {};
  }
  return {
    connector: event.connector,
    actorId: event.actor.id,
    conversationId: event.conversation.id,
  };
}

/**
 * Creates a bridge that listens to coding-worker approval events and binds the
 * corresponding approval request to a connector/actor/conversation so the
 * ingress layer can surface it.
 *
 * The returned function is a no-op for non-approval events.
 */
export function createApprovalEventBridge(
  ingress: ApprovalIngress,
  context: ApprovalEventBridgeContext = {},
): ApprovalEventBridge {
  return async (event: CodingWorkerEvent): Promise<void> => {
    if (
      event.type !== 'coding.approval.requested' &&
      event.type !== 'coding.github.approval_requested'
    ) {
      return;
    }

    let requestId = event.evidence?.[0];

    if (!requestId) {
      const request = await ingress.approvalService.createRequest({
        taskId: event.taskId,
        actionType: (event.action ?? 'file.edit') as CodingApprovalActionType,
        summary: event.summary ?? 'Approval requested.',
        reason: event.approvalReason ?? event.summary ?? 'Approval requested.',
        risk: event.risk ?? 'unknown',
      });
      requestId = request.id;
    } else {
      const record = await ingress.getApprovalRequest(requestId);
      if (!record) {
        const request = await ingress.approvalService.createRequest({
          taskId: event.taskId,
          actionType: (event.action ?? 'file.edit') as CodingApprovalActionType,
          summary: event.summary ?? 'Approval requested.',
          reason: event.approvalReason ?? event.summary ?? 'Approval requested.',
          risk: event.risk ?? 'unknown',
        });
        requestId = request.id;
      }
    }

    await ingress.bindApprovalRequest({
      requestId,
      connector: context.connector ?? 'unknown',
      actorId: context.actorId,
      conversationId: context.conversationId,
      createdAt: new Date().toISOString(),
    });
  };
}

/**
 * Wraps a `CodingProgressReporter` so that every emitted event is also fed to an
 * approval event bridge. The bridge runs asynchronously; {@link flush} awaits any
 * pending bridge work.
 */
export class BridgeCodingProgressReporter implements CodingProgressReporter {
  readonly #bridgePromises: Promise<void>[] = [];

  constructor(
    private readonly bridge: ApprovalEventBridge,
    private readonly inner: CodingProgressReporter,
  ) {}

  emit(event: Omit<CodingWorkerEvent, 'timestamp'> & { timestamp?: string }): void {
    this.inner.emit(event);
    const fullEvent = createCodingWorkerEvent(event);
    const promise = this.bridge(fullEvent).catch((error) => {
      console.error('Approval event bridge failed:', error);
    });
    this.#bridgePromises.push(promise);
  }

  events(): CodingWorkerEvent[] {
    return this.inner.events();
  }

  async flush(): Promise<void> {
    await Promise.all(this.#bridgePromises);
    this.#bridgePromises.length = 0;
  }
}
