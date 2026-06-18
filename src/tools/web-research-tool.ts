import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { goromboPersistenceRuntime } from '../db.js';
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
    'Researcher-only tool that runs the web research workflow with query planning, caching, web search, page fetch, source packing, and confidence metadata. Scope is read from the trusted eventId; do not guess actor or conversation identifiers.',
  parameters: v.object({
    eventId: v.string(),
    text: v.string(),
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
    const event = goromboPersistenceRuntime.sessionDatabase.getNormalizedMessageEvent(eventId);
    if (!event) {
      return JSON.stringify({
        error: `web_research requires a persisted event; ${eventId} not found`,
        eventId,
      });
    }

    return JSON.stringify(
      await runWebResearch({
        eventId: String(eventId),
        text: String(text),
        actorId: event.actor.id,
        conversationId: event.conversation.id,
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
