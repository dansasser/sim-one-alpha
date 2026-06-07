import { Type, defineTool } from '@flue/runtime';
import { DatabaseMemoryProviderPlaceholder } from '../memory/memory-provider.js';
import { MemoryRouter } from '../memory/memory-router.js';
import { DocumentIndexProviderPlaceholder, WebSearchProviderPlaceholder } from '../rag/providers.js';
import { RagRouter } from '../rag/rag-router.js';

const ragRouter = new RagRouter(new MemoryRouter(new DatabaseMemoryProviderPlaceholder('memory-db-placeholder')), [
  new WebSearchProviderPlaceholder(),
  new DocumentIndexProviderPlaceholder(),
]);

export const retrieveContextTool = defineTool({
  name: 'retrieve_context',
  description: 'Retrieve context through the RAG router across memory, web, and document-index placeholders.',
  parameters: Type.Object({
    eventId: Type.String(),
    text: Type.String(),
    actorId: Type.String(),
    conversationId: Type.String(),
  }),
  execute: async ({ eventId, text, actorId, conversationId }) => {
    return JSON.stringify(
      await ragRouter.retrieve({
        eventId: String(eventId),
        text: String(text),
        actorId: String(actorId),
        conversationId: String(conversationId),
      }),
    );
  },
});

