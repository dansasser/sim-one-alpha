import type { NormalizedMessageEvent } from '../types/index.js';
import { createEventId } from './base.js';

export interface WebApiMessageInput {
  connector?: NormalizedMessageEvent['connector'];
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

export function normalizeWebApiMessage(input: WebApiMessageInput): NormalizedMessageEvent {
  return {
    id: createEventId(input.connector === 'tui' ? 'tui' : 'web'),
    connector: input.connector ?? 'web-api',
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
