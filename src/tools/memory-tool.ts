import { Type, defineTool } from '@flue/runtime';
import { DatabaseMemoryProviderPlaceholder } from '../memory/memory-provider.js';
import { MemoryRouter } from '../memory/memory-router.js';

const router = new MemoryRouter(new DatabaseMemoryProviderPlaceholder('memory-db-placeholder'));

export const retrieveMemoryTool = defineTool({
  name: 'retrieve_memory',
  description: 'Retrieve relevant context from the database-backed memory placeholder.',
  parameters: Type.Object({
    eventId: Type.String(),
    text: Type.String(),
    actorId: Type.String(),
    conversationId: Type.String(),
  }),
  execute: async ({ eventId, text, actorId, conversationId }) => {
    const contexts = await router.retrieve({
      eventId: String(eventId),
      text: String(text),
      actorId: String(actorId),
      conversationId: String(conversationId),
      providers: ['memory'],
    });

    return JSON.stringify({ contexts });
  },
});

