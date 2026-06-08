import type { FlueContext } from '@flue/runtime';
import type { MemoryProvider } from '../memory/memory-provider.js';
import { createDefaultWebSearchProvider, type RagProvider } from '../rag/providers.js';
import { CachedWebSearchProvider } from '../research/cached-web-provider.js';
import {
  type ResearchCache,
  ResearchRunCache,
  createDefaultResearchCache,
} from '../research/research-cache.js';
import { estimateTextTokens } from '../session/context-budget.js';
import type { RagResultMetadata, RetrievedContext } from '../types/index.js';
import { retrieveContext, type WebFetchMode } from './retrieval.js';

export interface WebResearchWorkflowPayload {
  eventId: string;
  text: string;
  actorId: string;
  conversationId: string;
  maxQueries?: number;
  maxFetches?: number;
  maxContextTokens?: number;
  webFetch?: WebFetchMode;
  limit?: number;
  freshness?: ResearchFreshness;
}

export type ResearchFreshness = 'auto' | 'fresh' | 'cached';

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
    maxQueries: number;
    maxFetches: number;
    maxContextTokens: number;
    usedContextTokens: number;
  };
  providerFailures: NonNullable<RagResultMetadata['providerFailures']>;
}

export interface WebResearchWorkflowOptions {
  env?: Record<string, unknown>;
  cache?: ResearchCache;
  webProvider?: RagProvider;
  memoryProvider?: MemoryProvider;
}

export async function run({
  env,
  payload,
}: FlueContext<WebResearchWorkflowPayload>): Promise<WebResearchResult> {
  return runWebResearch(payload, { env });
}

export async function runWebResearch(
  payload: WebResearchWorkflowPayload,
  options: WebResearchWorkflowOptions = {},
): Promise<WebResearchResult> {
  const env = options.env ?? process.env;
  const maxQueries = readPositiveInteger(payload.maxQueries) ?? readPositiveInteger(env.GOROMBO_RESEARCH_MAX_QUERIES) ?? 3;
  const maxFetches = readPositiveInteger(payload.maxFetches) ?? readPositiveInteger(env.GOROMBO_RESEARCH_MAX_FETCHES) ?? 2;
  const maxContextTokens =
    readPositiveInteger(payload.maxContextTokens) ?? readPositiveInteger(env.GOROMBO_RESEARCH_MAX_CONTEXT_TOKENS) ?? 4_000;
  const limit = readPositiveInteger(payload.limit) ?? 5;
  const webFetch = payload.webFetch ?? 'auto';
  const freshness = payload.freshness ?? 'auto';
  const searchTtlMs = resolveTtlMs(freshness, env.GOROMBO_RESEARCH_SEARCH_TTL_MS, 30 * 60 * 1_000);
  const pageTtlMs = resolveTtlMs(freshness, env.GOROMBO_RESEARCH_PAGE_TTL_MS, 24 * 60 * 60 * 1_000);
  const runCache = new ResearchRunCache(options.cache ?? createDefaultResearchCache(env));
  const webProvider = new CachedWebSearchProvider(options.webProvider ?? createDefaultWebSearchProvider(env), {
    cache: runCache,
    searchTtlMs,
    pageTtlMs,
  });
  const queryPlan = buildResearchQueryPlan(payload.text, maxQueries);
  const allContexts: RetrievedContext[] = [];
  const providerFailures: NonNullable<RagResultMetadata['providerFailures']> = [];
  const queriesRun: string[] = [];
  let attemptedFetches = 0;

  for (const [index, query] of queryPlan.entries()) {
    if (attemptedFetches >= maxFetches && webFetch === 'always') {
      break;
    }

    const remainingFetches = Math.max(0, maxFetches - attemptedFetches);
    const result = await retrieveContext(
      {
        eventId: `${payload.eventId}:research:${index}`,
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

    if (hasEnoughEvidence(payload.text, allContexts, index + 1)) {
      break;
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
      maxQueries,
      maxFetches,
      maxContextTokens,
      usedContextTokens,
    },
    providerFailures,
  };
}

export function buildResearchQueryPlan(text: string, maxQueries: number): string[] {
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

  return [...new Set(queries.filter(Boolean))].slice(0, queryLimit);
}

function hasEnoughEvidence(request: string, contexts: RetrievedContext[], searchesRun: number): boolean {
  if (!contexts.length) {
    return false;
  }

  if (isComplexResearchPrompt(request)) {
    return contexts.length >= 3 && searchesRun >= 2;
  }

  return true;
}

function isComplexResearchPrompt(text: string): boolean {
  return /(research|compare|versus| vs |sources|citations|deep dive|investigate|options|alternatives)/i.test(text);
}

function packUniqueContexts(contexts: RetrievedContext[], maxContextTokens: number): RetrievedContext[] {
  const seen = new Set<string>();
  const sorted = [...contexts].sort((left, right) => right.score - left.score);
  const packed: RetrievedContext[] = [];
  let remainingTokens = Math.max(1, Math.floor(maxContextTokens));

  for (const context of sorted) {
    const url = typeof context.metadata?.url === 'string' ? context.metadata.url : '';
    const key = url || `${context.provider}:${context.title}`;
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

function resolveTtlMs(freshness: ResearchFreshness, value: unknown, fallback: number): number {
  if (freshness === 'fresh') {
    return 0;
  }

  return readPositiveInteger(value) ?? fallback;
}

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

const emptyMemoryProvider: MemoryProvider = {
  retrieve: async () => [],
};
