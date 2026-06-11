import type { ConnectorKind, NormalizedMessageEvent } from '../types/index.js';
import { createEventId } from './base.js';

export interface WebApiMessageInput {
  connector?: unknown;
  text: string;
  actorId: string;
  actorDisplayName?: string;
  conversationId: string;
  threadId?: string;
  clientId?: string;
  projectId?: string;
  workflow?: string;
  task?: string;
  raw?: unknown;
}

export type WebApiAcceptedConnector = Extract<ConnectorKind, 'web-api' | 'tui'>;

const acceptedWebApiConnectors = new Set<WebApiAcceptedConnector>(['web-api', 'tui']);

/**
 * Normalizes connector values accepted from the generic Web API payload.
 *
 * Public HTTP callers must not be able to opt into connector-only behavior by
 * sending `connector: "telegram"` or another future connector name. Trusted
 * connector ingresses should derive connector identity server-side before
 * handing events to chat workflow machinery.
 */
export function normalizeWebApiConnector(value: unknown): WebApiAcceptedConnector {
  return typeof value === 'string' && acceptedWebApiConnectors.has(value as WebApiAcceptedConnector)
    ? (value as WebApiAcceptedConnector)
    : 'web-api';
}

export function normalizeWebApiMessage(input: WebApiMessageInput): NormalizedMessageEvent {
  const connector = normalizeWebApiConnector(input.connector);

  return {
    id: createEventId(connector === 'tui' ? 'tui' : 'web'),
    connector,
    kind: 'chat.message',
    text: input.text,
    receivedAt: new Date().toISOString(),
    actor: {
      id: input.actorId,
      displayName: input.actorDisplayName,
    },
    conversation: {
      id: input.conversationId,
      threadId: input.threadId,
    },
    context: {
      clientId: input.clientId,
      projectId: input.projectId,
      workflow: input.workflow,
      task: input.task,
    },
    raw: input.raw,
  };
}
