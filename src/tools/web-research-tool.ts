import { Type, defineTool } from '@flue/runtime';
import { runWebResearch } from '../workflows/web-research.js';

export const webResearchTool = defineTool({
  name: 'web_research',
  description:
    'Researcher-only tool that runs the web research workflow with query planning, caching, web search, page fetch, source packing, and confidence metadata.',
  parameters: Type.Object({
    eventId: Type.String(),
    text: Type.String(),
    actorId: Type.String(),
    conversationId: Type.String(),
    maxQueries: Type.Optional(Type.Union([Type.Number(), Type.String()])),
    maxFetches: Type.Optional(Type.Union([Type.Number(), Type.String()])),
    maxContextTokens: Type.Optional(Type.Union([Type.Number(), Type.String()])),
    webFetch: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Union([Type.Number(), Type.String()])),
    freshness: Type.Optional(Type.String()),
  }),
  execute: async ({
    eventId,
    text,
    actorId,
    conversationId,
    maxQueries,
    maxFetches,
    maxContextTokens,
    webFetch,
    limit,
    freshness,
  }) => {
    return JSON.stringify(
      await runWebResearch({
        eventId: String(eventId),
        text: String(text),
        actorId: String(actorId),
        conversationId: String(conversationId),
        maxQueries: readPositiveInteger(maxQueries),
        maxFetches: readPositiveInteger(maxFetches),
        maxContextTokens: readPositiveInteger(maxContextTokens),
        webFetch: readWebFetchMode(webFetch),
        limit: readPositiveInteger(limit),
        freshness: readFreshness(freshness),
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

function readFreshness(value: unknown): 'auto' | 'fresh' | 'cached' | undefined {
  return value === 'auto' || value === 'fresh' || value === 'cached' ? value : undefined;
}
