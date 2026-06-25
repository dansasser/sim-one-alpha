import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { goromboPersistenceRuntime } from '../../db.js';
import {
  SqliteProtocolProvider,
  defaultProtocolDatabasePath,
} from '../../core/protocols/sqlite-protocol-provider.js';
import type { NormalizedMessageEvent } from '../../core/types/index.js';

const dbPath = process.env.GOROMBO_PROTOCOL_DB_PATH ?? defaultProtocolDatabasePath;
const provider = new SqliteProtocolProvider(dbPath);

export interface ProtocolToolInput {
  eventId: unknown;
  connector?: unknown;
  messageKind?: unknown;
  actorId?: unknown;
  conversationId?: unknown;
  threadId?: unknown;
  clientId?: unknown;
  projectId?: unknown;
  workflow?: unknown;
  task?: unknown;
}

export const loadProtocolsTool = defineTool({
  name: 'load_protocols',
  description: 'Load applicable protocol directives from the SQLite protocol store.',
  parameters: v.object({
    eventId: v.string(),
    connector: v.optional(v.string()),
    messageKind: v.optional(v.string()),
    actorId: v.optional(v.string()),
    conversationId: v.optional(v.string()),
    threadId: v.optional(v.string()),
    clientId: v.optional(v.string()),
    projectId: v.optional(v.string()),
    workflow: v.optional(v.string()),
    task: v.optional(v.string()),
  }),
  execute: async (input) => {
    const event = createProtocolLookupEvent(input as ProtocolToolInput);
    const bundle = await provider.loadApplicable(event);

    return JSON.stringify(bundle);
  },
});

export function createProtocolLookupEvent(input: ProtocolToolInput): NormalizedMessageEvent {
  const eventId = readNonEmptyString(input.eventId);
  if (!eventId) {
    throw new Error('load_protocols requires a persisted eventId.');
  }

  const registeredEvent = goromboPersistenceRuntime.sessionDatabase.getNormalizedMessageEvent(eventId);
  if (!registeredEvent) {
    throw new Error(`No persisted normalized message event found for eventId ${eventId}.`);
  }

  const context = registeredEvent.context ?? {};

  return {
    id: eventId,
    connector: registeredEvent.connector ?? 'unknown',
    kind: registeredEvent.kind ?? 'chat.message',
    text: registeredEvent.text ?? '',
    receivedAt: registeredEvent.receivedAt ?? new Date().toISOString(),
    actor: {
      id: registeredEvent.actor?.id ?? 'tool-call',
      ...(registeredEvent.actor?.displayName ? { displayName: registeredEvent.actor.displayName } : {}),
    },
    conversation: {
      id: registeredEvent.conversation?.id ?? 'tool-call',
      ...(registeredEvent.conversation?.threadId ? { threadId: registeredEvent.conversation.threadId } : {}),
    },
    ...(context.clientId || context.projectId || context.workflow || context.task
      ? {
          context: {
            ...(context.clientId ? { clientId: context.clientId } : {}),
            ...(context.projectId ? { projectId: context.projectId } : {}),
            ...(context.workflow ? { workflow: context.workflow } : {}),
            ...(context.task ? { task: context.task } : {}),
          },
        }
      : {}),
  };
}

export function rememberProtocolLookupEvent(event: NormalizedMessageEvent): void {
  goromboPersistenceRuntime.sessionDatabase.recordNormalizedMessageEvent({
    event: {
      id: event.id,
      connector: event.connector,
      kind: event.kind,
      text: event.text,
      receivedAt: event.receivedAt,
      actor: { ...event.actor },
      conversation: { ...event.conversation },
      ...(event.context ? { context: { ...event.context } } : {}),
    },
  });
}

export function forgetProtocolLookupEvent(eventId: string): void {
  goromboPersistenceRuntime.sessionDatabase.deleteNormalizedMessageEvent(eventId);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
