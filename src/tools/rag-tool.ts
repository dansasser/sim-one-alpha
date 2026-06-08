import { Type, defineTool } from '@flue/runtime';
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
        fetchTopK: readPositiveInteger(fetchTopK),
      }),
    );
  },
});

function readPositiveInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
  }

  return undefined;
}

function readWebFetchMode(value: unknown): 'auto' | 'always' | 'never' | undefined {
  return value === 'auto' || value === 'always' || value === 'never' ? value : undefined;
}
