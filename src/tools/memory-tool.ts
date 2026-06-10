import { Type, defineTool } from '@flue/runtime';
import { SessionMemoryProvider } from '../memory/memory-provider.js';
import { MemoryRouter } from '../memory/memory-router.js';

const router = new MemoryRouter(new SessionMemoryProvider());

export const retrieveMemoryTool = defineTool({
  name: 'retrieve_memory',
  description: 'Retrieve relevant context from persisted session memory.',
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
