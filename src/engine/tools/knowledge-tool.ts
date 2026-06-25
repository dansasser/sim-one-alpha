import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { goromboPersistenceRuntime } from '../../db.js';
import { sharedKnowledgeStore } from '../memory/knowledge-service.js';
import type { NormalizedMessageEvent } from '../../core/types/index.js';

const store = sharedKnowledgeStore;

export const addKnowledgeTool = defineTool({
  name: 'add_knowledge',
  description:
    'Add a piece of knowledge to the searchable vector knowledge base. Use this when the user shares a fact, preference, instruction, or context that should be remembered and retrievable later.',
  parameters: v.object({
    eventId: v.string(),
    title: v.string(),
    content: v.string(),
    tags: v.optional(v.array(v.string())),
  }),
  execute: async ({ eventId, title, content, tags }) => {
    const event = getTrustedKnowledgeEvent(eventId);

    const actorId = event.actor.id;
    const conversationId = event.conversation.id;

    const record = await store.add({
      title: String(title),
      content: String(content),
      actorId,
      conversationId,
      tags: Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : undefined,
      source: 'agent_tool',
      createdBy: actorId,
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
