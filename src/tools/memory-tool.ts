import { Type, defineTool } from '@flue/runtime';
import { goromboPersistenceRuntime } from '../db.js';
import { SessionMemoryProvider } from '../memory/memory-provider.js';
import { MemoryRouter } from '../memory/memory-router.js';
import type { NormalizedMessageEvent } from '../types/index.js';

const router = new MemoryRouter(new SessionMemoryProvider());

export const retrieveMemoryTool = defineTool({
  name: 'retrieve_memory',
  description: 'Retrieve relevant context from persisted session memory.',
  parameters: Type.Object({
    eventId: Type.String(),
    text: Type.String(),
  }),
  execute: async ({ eventId, text }) => {
    const event = getTrustedMemoryLookupEvent(eventId);
    const actorId = requireScopeValue(event.actor.id, 'actorId');
    const conversationId = requireScopeValue(event.conversation.id, 'conversationId');
    const contexts = await router.retrieve({
      eventId: String(eventId),
      text: String(text),
      actorId,
      conversationId,
      providers: ['memory'],
    });

    return JSON.stringify({ contexts });
  },
});

export function rememberMemoryLookupEvent(event: NormalizedMessageEvent): void {
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

function getTrustedMemoryLookupEvent(eventId: unknown): NormalizedMessageEvent {
  const event = goromboPersistenceRuntime.sessionDatabase.getNormalizedMessageEvent(String(eventId));
  if (!event) {
    throw new Error('retrieve_memory requires a trusted eventId persisted by chat ingress.');
  }
  return event;
}

function requireScopeValue(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`retrieve_memory cannot run without trusted ${fieldName}.`);
  }
  return value.trim();
}
