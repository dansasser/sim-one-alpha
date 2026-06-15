import { Type, defineTool } from '@flue/runtime';
import { goromboPersistenceRuntime } from '../db.js';
import { LanceDbKnowledgeStore } from '../rag/knowledge-store.js';
import type { NormalizedMessageEvent } from '../types/index.js';

const store = new LanceDbKnowledgeStore({
  vectorStore: goromboPersistenceRuntime.vectorStore,
  embeddingClient: goromboPersistenceRuntime.embeddingClient,
});

export const addKnowledgeTool = defineTool({
  name: 'add_knowledge',
  description:
    'Add a piece of knowledge to the searchable vector knowledge base. Use this when the user shares a fact, preference, instruction, or context that should be remembered and retrievable later.',
  parameters: Type.Object({
    eventId: Type.String(),
    title: Type.String(),
    content: Type.String(),
    tags: Type.Optional(Type.Array(Type.String())),
  }),
  execute: async ({ eventId, title, content, tags }) => {
    const event = getTrustedKnowledgeEvent(eventId);
    const record = await store.add({
      title: String(title),
      content: String(content),
      actorId: event.actor.id,
      conversationId: event.conversation.id,
      tags: Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : undefined,
      source: 'agent_tool',
      createdBy: event.actor.id,
    });

    return JSON.stringify({ record });
  },
});

export function rememberKnowledgeEvent(event: NormalizedMessageEvent): void {
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

function getTrustedKnowledgeEvent(eventId: unknown): NormalizedMessageEvent {
  const event = goromboPersistenceRuntime.sessionDatabase.getNormalizedMessageEvent(String(eventId));
  if (!event) {
    throw new Error('add_knowledge requires a trusted eventId persisted by chat ingress.');
  }
  return event;
}
