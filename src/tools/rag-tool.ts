import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { readNonNegativeInteger, readPositiveInteger, readWebFetchMode } from '../utils/input.js';
import { retrieveContext } from '../workflows/retrieval.js';

export const retrieveContextTool = defineTool({
  name: 'retrieve_context',
  description:
    'Researcher-only retrieval tool. It can call the RAG workflow, use Ollama Search when configured, fetch top web pages, and pack returned context to a token budget.',
  parameters: v.object({
    eventId: v.string(),
    text: v.string(),
    actorId: v.string(),
    conversationId: v.string(),
    limit: v.optional(v.number()),
    maxContextTokens: v.optional(v.number()),
    webFetch: v.optional(v.union([v.literal('auto'), v.literal('always'), v.literal('never')])),
    fetchTopK: v.optional(v.number()),
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
