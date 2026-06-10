import { Type, defineTool } from '@flue/runtime';
import {
  readNonNegativeInteger,
  readPositiveInteger,
  readResearchDepth,
  readResearchFreshness,
  readWebFetchMode,
} from '../utils/input.js';
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
    depth: Type.Optional(Type.String()),
    maxQueries: Type.Optional(Type.Union([Type.Number(), Type.String()])),
    maxFetches: Type.Optional(Type.Union([Type.Number(), Type.String()])),
    maxContextTokens: Type.Optional(Type.Union([Type.Number(), Type.String()])),
    webFetch: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Union([Type.Number(), Type.String()])),
    freshness: Type.Optional(Type.String()),
    minSources: Type.Optional(Type.Union([Type.Number(), Type.String()])),
    maxIterations: Type.Optional(Type.Union([Type.Number(), Type.String()])),
  }),
  execute: async ({
    eventId,
    text,
    actorId,
    conversationId,
    depth,
    maxQueries,
    maxFetches,
    maxContextTokens,
    webFetch,
    limit,
    freshness,
    minSources,
    maxIterations,
  }) => {
    return JSON.stringify(
      await runWebResearch({
        eventId: String(eventId),
        text: String(text),
        actorId: String(actorId),
        conversationId: String(conversationId),
        depth: readResearchDepth(depth),
        maxQueries: readPositiveInteger(maxQueries),
        maxFetches: readNonNegativeInteger(maxFetches),
        maxContextTokens: readPositiveInteger(maxContextTokens),
        webFetch: readWebFetchMode(webFetch),
        limit: readPositiveInteger(limit),
        freshness: readResearchFreshness(freshness),
        minSources: readPositiveInteger(minSources),
        maxIterations: readPositiveInteger(maxIterations),
      }),
    );
  },
});
