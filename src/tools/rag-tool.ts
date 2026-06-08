import { Type, defineTool } from '@flue/runtime';
import { retrieveContext } from '../workflows/retrieval.js';

export const retrieveContextTool = defineTool({
  name: 'retrieve_context',
  description:
    'Retrieve context through the RAG router. Web search uses Ollama Search when configured; memory and document-index providers are placeholders.',
  parameters: Type.Object({
    eventId: Type.String(),
    text: Type.String(),
    actorId: Type.String(),
    conversationId: Type.String(),
  }),
  execute: async ({ eventId, text, actorId, conversationId }) => {
    return JSON.stringify(
      await retrieveContext({
        eventId: String(eventId),
        text: String(text),
        actorId: String(actorId),
        conversationId: String(conversationId),
      }),
    );
  },
});
