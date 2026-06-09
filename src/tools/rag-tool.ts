import { Type, defineTool } from '@flue/runtime';
import { readNonNegativeInteger, readPositiveInteger, readWebFetchMode } from '../utils/input.js';
import { retrieveContext } from '../workflows/retrieval.js';

export const retrieveContextTool = defineTool({
  name: 'retrieve_context',
  description:
    'Researcher-only retrieval tool. It can call the RAG workflow, use Ollama Search when configured, fetch top web pages, and pack returned context to a token budget.',
  parameters: Type.Object({
    eventId: Type.String(),
    text: Type.String(),
    actorId: Type.String(),
    conversationId: Type.String(),
    limit: Type.Optional(Type.Number()),
    maxContextTokens: Type.Optional(Type.Number()),
    webFetch: Type.Optional(Type.Union([Type.Literal('auto'), Type.Literal('always'), Type.Literal('never')])),
    fetchTopK: Type.Optional(Type.Number()),
  }),
  execute: async ({ eventId, text, actorId, conversationId, limit, maxContextTokens, webFetch, fetchTopK }) => {
    return JSON.stringify(
      await retrieveContext({
        eventId: String(eventId),
        text: String(text),
        actorId: String(actorId),
        conversationId: String(conversationId),
        caller: 'researcher',
        limit: readPositiveInteger(limit),
        maxContextTokens: readPositiveInteger(maxContextTokens),
        webFetch: readWebFetchMode(webFetch),
        fetchTopK: readNonNegativeInteger(fetchTopK),
      }),
    );
  },
});
