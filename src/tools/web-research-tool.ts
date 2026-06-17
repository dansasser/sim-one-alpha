import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
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
  parameters: v.object({
    eventId: v.string(),
    text: v.string(),
    actorId: v.string(),
    conversationId: v.string(),
    depth: v.optional(v.string()),
    maxQueries: v.optional(v.union([v.number(), v.string()])),
    maxFetches: v.optional(v.union([v.number(), v.string()])),
    maxContextTokens: v.optional(v.union([v.number(), v.string()])),
    webFetch: v.optional(v.string()),
    limit: v.optional(v.union([v.number(), v.string()])),
    freshness: v.optional(v.string()),
    minSources: v.optional(v.union([v.number(), v.string()])),
    maxIterations: v.optional(v.union([v.number(), v.string()])),
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
