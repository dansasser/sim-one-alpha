import type { FlueContext } from '@flue/runtime';
import type { MemoryProvider } from '../memory/memory-provider.js';
import { createDefaultWebSearchProvider, type RagProvider } from '../rag/providers.js';
import { CachedWebSearchProvider } from '../workers/researcher/research/cached-web-provider.js';
import {
  type ResearchCache,
  ResearchRunCache,
  createDefaultResearchCache,
} from '../workers/researcher/research/research-cache.js';
import { estimateTextTokens } from '../session/context-budget.js';
import type { RagResultMetadata, RetrievedContext } from '../types/index.js';
import {
  readNonNegativeInteger,
  readPositiveInteger,
  readResearchDepth,
  readResearchFreshness,
  readWebFetchMode,
} from '../utils/input.js';
import { retrieveContext, type WebFetchMode } from './retrieval.js';

export interface WebResearchWorkflowPayload {
  eventId: string;
  text: string;
  actorId: string;
  conversationId: string;
  depth?: ResearchDepth;
  maxQueries?: number;
  maxFetches?: number;
  maxContextTokens?: number;
  webFetch?: WebFetchMode;
  limit?: number;
  freshness?: ResearchFreshness;
  minSources?: number;
  maxIterations?: number;
}

export type ResearchFreshness = 'auto' | 'fresh' | 'cached';
export type ResearchDepth = 'basic' | 'standard' | 'deep';

export interface SourceEvidence {
  id: string;
  title: string;
  url?: string;
  provider: string;
  score: number;
  content: string;
  cache?: unknown;
}

export interface WebResearchResult {
  request: string;
  status: 'completed' | 'no_results';
  queriesRun: string[];
  sources: SourceEvidence[];
  contexts: RetrievedContext[];
  confidence: number;
  cache: {
    searchHits: number;
    searchMisses: number;
    pageHits: number;
    pageMisses: number;
  };
  budget: {
    depth: ResearchDepth;
    maxQueries: number;
    maxFetches: number;
    maxContextTokens: number;
    usedContextTokens: number;
    minSources: number;
    maxIterations: number;
    iterationsRun: number;
  };
  providerFailures: NonNullable<RagResultMetadata['providerFailures']>;
}

export interface WebResearchWorkflowOptions {
  env?: Record<string, unknown>;
  cache?: ResearchCache;
  webProvider?: RagProvider;
  memoryProvider?: MemoryProvider;
}

/**
 * Flue workflow entrypoint for source-backed web research runs.
 */
export async function run({
  env,
  payload,
}: FlueContext<WebResearchWorkflowPayload>): Promise<WebResearchResult> {
  return runWebResearch(payload, { env });
}

/**
 * Runs bounded web research using query planning, cache-aware search, optional page fetch, and evidence packing.
 */
export async function runWebResearch(
  payload: WebResearchWorkflowPayload,
  options: WebResearchWorkflowOptions = {},
): Promise<WebResearchResult> {
  const env = options.env ?? process.env;
  const settings = resolveResearchSettings(payload, env);
  const {
    depth,
    maxQueries,
    maxFetches,
    maxContextTokens,
    limit,
    webFetch,
    freshness,
    minSources,
    maxIterations,
  } = settings;
  const searchTtlMs = resolveTtlMs(freshness, env.GOROMBO_RESEARCH_SEARCH_TTL_MS, 30 * 60 * 1_000);
  const pageTtlMs = resolveTtlMs(freshness, env.GOROMBO_RESEARCH_PAGE_TTL_MS, 24 * 60 * 60 * 1_000);
  const persistentCache = options.cache ?? createDefaultResearchCache(env);
  const shouldClosePersistentCache = !options.cache;
  const runCache = new ResearchRunCache(persistentCache);
  const webProvider = new CachedWebSearchProvider(options.webProvider ?? createDefaultWebSearchProvider(env), {
    cache: runCache,
    searchTtlMs,
    pageTtlMs,
    bypassCacheReads: freshness === 'fresh',
  });

  try {
    const queryPlan = buildResearchQueryPlan(payload.text, maxQueries, depth);
    const allContexts: RetrievedContext[] = [];
    const providerFailures: NonNullable<RagResultMetadata['providerFailures']> = [];
    const queriesRun: string[] = [];
    let attemptedFetches = 0;
    let searchIndex = 0;
    let iterationsRun = 0;
    let enoughEvidence = false;
    const queriesPerIteration =
      depth === 'deep' ? Math.max(1, Math.ceil(queryPlan.length / maxIterations)) : queryPlan.length;

    while (searchIndex < queryPlan.length && iterationsRun < maxIterations && !enoughEvidence) {
      iterationsRun += 1;
      const iterationEnd = Math.min(queryPlan.length, searchIndex + queriesPerIteration);

      for (; searchIndex < iterationEnd; searchIndex += 1) {
        const query = queryPlan[searchIndex];
        const remainingFetches = Math.max(0, maxFetches - attemptedFetches);
        const result = await retrieveContext(
          {
            eventId: `${payload.eventId}:research:${searchIndex}`,
            text: query,
            actorId: payload.actorId,
            conversationId: payload.conversationId,
            providers: ['web-search'],
            caller: 'researcher',
            limit,
            maxContextTokens,
            webFetch,
            fetchTopK: remainingFetches,
          },
          {
            env,
            memoryProvider: options.memoryProvider ?? emptyMemoryProvider,
            providers: [webProvider],
          },
        );

        queriesRun.push(query);
        allContexts.push(...result.contexts);
        attemptedFetches += result.metadata?.webFetch?.attempted ?? 0;
        providerFailures.push(...(result.metadata?.providerFailures ?? []));

        if (hasEnoughEvidence(payload.text, allContexts, queriesRun.length, settings)) {
          enoughEvidence = true;
          break;
        }
      }
    }

    const contexts = packUniqueContexts(allContexts, maxContextTokens);
    const sources = contexts.map(toSourceEvidence);
    const usedContextTokens = contexts.reduce((total, context) => total + estimateTextTokens(context.content), 0);

    return {
      request: payload.text,
      status: contexts.length ? 'completed' : 'no_results',
      queriesRun,
      sources,
      contexts,
      confidence: calculateConfidence(payload.text, sources, providerFailures),
      cache: { ...runCache.stats },
      budget: {
        depth,
        maxQueries,
        maxFetches,
        maxContextTokens,
        usedContextTokens,
        minSources,
        maxIterations,
        iterationsRun,
      },
      providerFailures,
    };
  } finally {
    if (shouldClosePersistentCache) {
      await persistentCache.close?.();
    }
  }
}

/**
 * Builds a small query plan from the request and selected research depth.
 */
export function buildResearchQueryPlan(
  text: string,
  maxQueries: number,
  depth: ResearchDepth = 'standard',
): string[] {
  const queryLimit = Math.max(1, Math.floor(maxQueries));
  const normalized = text.trim();
  const queries = [normalized];
  const lower = normalized.toLowerCase();

  if (/(official|docs|documentation|api|reference)/.test(lower)) {
    queries.push(`${normalized} official documentation`);
  }

  if (/(latest|current|recent|today|2026|news|release)/.test(lower)) {
    queries.push(`${normalized} latest`);
  }

  if (/(compare|versus| vs |best|alternatives|options)/.test(lower)) {
    queries.push(`${normalized} comparison sources`);
  }

  if (depth === 'deep') {
    queries.push(
      `${normalized} primary sources`,
      `${normalized} analysis`,
      `${normalized} limitations risks`,
      `${normalized} recent developments`,
    );
  }

  return [...new Set(queries.filter(Boolean))].slice(0, queryLimit);
}

interface ResearchSettings {
  depth: ResearchDepth;
  maxQueries: number;
  maxFetches: number;
  maxContextTokens: number;
  limit: number;
  webFetch: WebFetchMode;
  freshness: ResearchFreshness;
  minSources: number;
  maxIterations: number;
}

/**
 * Decides whether gathered evidence satisfies the configured source and iteration requirements.
 */
function hasEnoughEvidence(
  request: string,
  contexts: RetrievedContext[],
  searchesRun: number,
  settings: ResearchSettings,
): boolean {
  const uniqueSourceCount = countUniqueSources(contexts);

  if (!uniqueSourceCount) {
    return false;
  }

  if (uniqueSourceCount < settings.minSources) {
    return false;
  }

  if (settings.depth === 'deep') {
    return searchesRun >= Math.min(2, settings.maxQueries);
  }

  if (isComplexResearchPrompt(request)) {
    return uniqueSourceCount >= settings.minSources && searchesRun >= 2;
  }

  return true;
}

/**
 * Detects prompts that need at least two searches before stopping.
 */
function isComplexResearchPrompt(text: string): boolean {
  return /(research|compare|versus| vs |sources|citations|deep dive|investigate|options|alternatives)/i.test(text);
}

/**
 * Packs the highest-scoring unique source contexts inside the context token budget.
 */
function packUniqueContexts(contexts: RetrievedContext[], maxContextTokens: number): RetrievedContext[] {
  const seen = new Set<string>();
  const sorted = [...contexts].sort((left, right) => right.score - left.score);
  const packed: RetrievedContext[] = [];
  let remainingTokens = Math.max(1, Math.floor(maxContextTokens));

  for (const context of sorted) {
    const key = createSourceKey(context);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const tokenEstimate = estimateTextTokens(context.content);
    if (tokenEstimate > remainingTokens) {
      continue;
    }

    packed.push(context);
    remainingTokens -= tokenEstimate;
  }

  return packed;
}

/**
 * Counts distinct source keys using the same identity rule as final source packing.
 */
function countUniqueSources(contexts: RetrievedContext[]): number {
  return new Set(contexts.map(createSourceKey)).size;
}

/**
 * Creates a stable source key from URL when present, otherwise provider and title.
 */
function createSourceKey(context: RetrievedContext): string {
  const url = typeof context.metadata?.url === 'string' ? context.metadata.url : '';
  return url || `${context.provider}:${context.title}`;
}

/**
 * Converts a retrieved context into the public source evidence shape.
 */
function toSourceEvidence(context: RetrievedContext): SourceEvidence {
  return {
    id: context.id,
    title: context.title,
    url: typeof context.metadata?.url === 'string' ? context.metadata.url : undefined,
    provider: typeof context.metadata?.provider === 'string' ? context.metadata.provider : context.provider,
    score: context.score,
    content: context.content,
    cache: context.metadata?.cache,
  };
}

/**
 * Estimates confidence from source count, official-source hints, prompt complexity, and provider failures.
 */
function calculateConfidence(
  request: string,
  sources: SourceEvidence[],
  providerFailures: NonNullable<RagResultMetadata['providerFailures']>,
): number {
  if (!sources.length) {
    return 0;
  }

  let confidence = sources.length === 1 ? 0.45 : 0.65;
  if (sources.some((source) => /official|docs|documentation|api/i.test(`${source.title} ${source.url ?? ''}`))) {
    confidence += 0.15;
  }
  if (isComplexResearchPrompt(request) && sources.length >= 3) {
    confidence += 0.1;
  }
  if (providerFailures.length) {
    confidence -= 0.15;
  }

  return Math.max(0, Math.min(0.95, confidence));
}

/**
 * Resolves explicit payload controls, environment overrides, and depth defaults into one settings object.
 */
function resolveResearchSettings(
  payload: WebResearchWorkflowPayload,
  env: Record<string, unknown>,
): ResearchSettings {
  const depth = readResearchDepth(payload.depth) ?? readResearchDepth(env.GOROMBO_RESEARCH_DEPTH) ?? 'standard';
  const defaults = researchDepthDefaults[depth];
  const freshness =
    readResearchFreshness(payload.freshness) ??
    readResearchFreshness(env.GOROMBO_RESEARCH_FRESHNESS) ??
    (needsFreshResearch(payload.text) ? 'fresh' : defaults.freshness);

  return {
    depth,
    maxQueries:
      readPositiveInteger(payload.maxQueries) ??
      readPositiveInteger(env.GOROMBO_RESEARCH_MAX_QUERIES) ??
      defaults.maxQueries,
    maxFetches:
      readNonNegativeInteger(payload.maxFetches) ??
      readNonNegativeInteger(env.GOROMBO_RESEARCH_MAX_FETCHES) ??
      defaults.maxFetches,
    maxContextTokens:
      readPositiveInteger(payload.maxContextTokens) ??
      readPositiveInteger(env.GOROMBO_RESEARCH_MAX_CONTEXT_TOKENS) ??
      defaults.maxContextTokens,
    limit: readPositiveInteger(payload.limit) ?? readPositiveInteger(env.GOROMBO_RESEARCH_LIMIT) ?? defaults.limit,
    webFetch: payload.webFetch ?? readWebFetchMode(env.GOROMBO_RESEARCH_WEB_FETCH) ?? defaults.webFetch,
    freshness,
    minSources:
      readPositiveInteger(payload.minSources) ??
      readPositiveInteger(env.GOROMBO_RESEARCH_MIN_SOURCES) ??
      defaults.minSources,
    maxIterations:
      readPositiveInteger(payload.maxIterations) ??
      readPositiveInteger(env.GOROMBO_RESEARCH_MAX_ITERATIONS) ??
      defaults.maxIterations,
  };
}

const researchDepthDefaults: Record<ResearchDepth, ResearchSettings> = {
  basic: {
    depth: 'basic',
    maxQueries: 1,
    maxFetches: 1,
    maxContextTokens: 1_500,
    limit: 3,
    webFetch: 'auto',
    freshness: 'auto',
    minSources: 1,
    maxIterations: 1,
  },
  standard: {
    depth: 'standard',
    maxQueries: 3,
    maxFetches: 2,
    maxContextTokens: 4_000,
    limit: 5,
    webFetch: 'auto',
    freshness: 'auto',
    minSources: 2,
    maxIterations: 1,
  },
  deep: {
    depth: 'deep',
    maxQueries: 6,
    maxFetches: 5,
    maxContextTokens: 10_000,
    limit: 8,
    webFetch: 'always',
    freshness: 'auto',
    minSources: 5,
    maxIterations: 3,
  },
};

/**
 * Resolves cache TTL while forcing fresh mode to bypass existing cache entries.
 */
function resolveTtlMs(freshness: ResearchFreshness, value: unknown, fallback: number): number {
  if (freshness === 'fresh') {
    return 0;
  }

  return readPositiveInteger(value) ?? fallback;
}

/**
 * Detects prompts that should prefer fresh search results over cached entries.
 */
function needsFreshResearch(text: string): boolean {
  return /\b(current|latest|recent|today|yesterday|tomorrow|now|breaking|news|2026)\b/i.test(text);
}

const emptyMemoryProvider: MemoryProvider = {
  retrieve: async () => [],
};
