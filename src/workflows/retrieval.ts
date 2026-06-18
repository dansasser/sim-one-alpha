import type { FlueContext } from '@flue/runtime';
import type { MemoryProvider } from '../memory/memory-provider.js';
import { SessionMemoryProvider } from '../memory/memory-provider.js';
import { MemoryRouter } from '../memory/memory-router.js';
import { goromboPersistenceRuntime } from '../db.js';
import { DocumentIndexProvider } from '../rag/document-index-provider.js';
import {
  createDefaultWebSearchProvider,
  type RagProvider,
  type WebFetchResult,
} from '../rag/providers.js';
import { RagRouter } from '../rag/rag-router.js';
import { estimateTextTokens } from '../session/context-budget.js';
import type { RagProviderKind, RagResult, RetrievedContext, RetrievalCaller } from '../types/index.js';
import { readNonNegativeInteger, readPositiveInteger } from '../utils/input.js';

export type WebFetchMode = 'auto' | 'always' | 'never';

export interface RetrievalWorkflowPayload {
  eventId: string;
  text: string;
  actorId: string;
  conversationId: string;
  providers?: RagProviderKind[];
  caller?: RetrievalCaller;
  limit?: number;
  maxContextTokens?: number;
  webFetch?: WebFetchMode;
  fetchTopK?: number;
}

export interface RetrievalWorkflowOptions {
  env?: Record<string, unknown>;
  memoryProvider?: MemoryProvider;
  providers?: RagProvider[];
}

export async function run({
  env,
  payload,
}: FlueContext<RetrievalWorkflowPayload>): Promise<RagResult> {
  return retrieveContext(payload, { env });
}

export async function retrieveContext(
  payload: RetrievalWorkflowPayload,
  options: RetrievalWorkflowOptions = {},
): Promise<RagResult> {
  const env = options.env ?? process.env;
  const providers = options.providers ?? createDefaultRetrievalProviders(env);
  const selectedProviders = payload.providers ?? selectProvidersForPrompt(payload.text);

  assertWebSearchCaller(selectedProviders, payload.caller);

  const router = createRetrievalRouter(env, { ...options, providers });
  const result = await router.retrieve({
    eventId: String(payload.eventId),
    text: String(payload.text),
    actorId: String(payload.actorId),
    conversationId: String(payload.conversationId),
    providers: selectedProviders,
    caller: payload.caller,
    limit: payload.limit,
  });
  const webFetchMode = payload.webFetch ?? 'auto';
  const webFetchResult = await enrichWebResults({
    contexts: result.contexts,
    providers,
    mode: webFetchMode,
    fetchTopK: readNonNegativeInteger(payload.fetchTopK) ?? readNonNegativeInteger(env.GOROMBO_RAG_WEB_FETCH_TOP_K) ?? 1,
    shouldFetch:
      selectedProviders.includes('web-search') &&
      (webFetchMode === 'always' || (webFetchMode === 'auto' && isSourceBackedPrompt(payload.text))),
  });
  const budget = packContexts(
    webFetchResult.contexts,
    readPositiveInteger(payload.maxContextTokens) ?? readPositiveInteger(env.GOROMBO_RAG_MAX_CONTEXT_TOKENS) ?? 4_000,
  );

  return {
    ...result,
    contexts: budget.contexts,
    metadata: {
      ...result.metadata,
      retrieval: {
        selectedProviders,
      },
      webFetch: {
        mode: webFetchMode,
        attempted: webFetchResult.attempted,
        succeeded: webFetchResult.succeeded,
        failed: webFetchResult.failed,
      },
      budget: {
        maxContextTokens: budget.maxContextTokens,
        usedContextTokens: budget.usedContextTokens,
        truncatedContextCount: budget.truncatedContextCount,
        omittedContextCount: budget.omittedContextCount,
      },
    },
  };
}

export function createRetrievalRouter(
  env: Record<string, unknown> = process.env,
  options: RetrievalWorkflowOptions = {},
): RagRouter {
  return new RagRouter(
    MemoryRouter.fromSingle('memory', options.memoryProvider ?? new SessionMemoryProvider()),
    options.providers ?? createDefaultRetrievalProviders(env),
  );
}

export function createDefaultRetrievalProviders(env: Record<string, unknown> = process.env): RagProvider[] {
  return [
    createDefaultWebSearchProvider(env),
    new DocumentIndexProvider({
      vectorStore: goromboPersistenceRuntime.vectorStore,
      embeddingClient: goromboPersistenceRuntime.embeddingClient,
    }),
  ];
}

export function selectProvidersForPrompt(text: string): RagProviderKind[] {
  const providers: RagProviderKind[] = ['memory'];

  if (isSourceBackedPrompt(text)) {
    providers.push('web-search');
  }

  if (isProjectDocumentPrompt(text)) {
    providers.push('document-index');
  }

  return providers;
}

function assertWebSearchCaller(providers: RagProviderKind[], caller: RetrievalCaller | undefined): void {
  if (!providers.includes('web-search')) {
    return;
  }

  if (caller === 'researcher' || caller === 'research-workflow') {
    return;
  }

  throw new Error('Web search retrieval is restricted to the researcher subagent or research workflow.');
}

interface WebFetchProvider extends RagProvider {
  fetchPage(url: string): Promise<WebFetchResult>;
}

interface WebFetchSummary {
  contexts: RetrievedContext[];
  attempted: number;
  succeeded: number;
  failed: number;
}

async function enrichWebResults(input: {
  contexts: RetrievedContext[];
  providers: RagProvider[];
  mode: WebFetchMode;
  fetchTopK: number;
  shouldFetch: boolean;
}): Promise<WebFetchSummary> {
  if (input.mode === 'never' || !input.shouldFetch) {
    return {
      contexts: input.contexts,
      attempted: 0,
      succeeded: 0,
      failed: 0,
    };
  }

  const fetchProvider = input.providers.find(isWebFetchProvider);
  if (!fetchProvider) {
    return {
      contexts: input.contexts,
      attempted: 0,
      succeeded: 0,
      failed: 0,
    };
  }

  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  const remainingFetches = Math.max(0, input.fetchTopK);

  const contexts = await Promise.all(
    input.contexts.map(async (context) => {
      const url = readString(context.metadata?.url);
      if (context.provider !== 'web-search' || !url || attempted >= remainingFetches) {
        return context;
      }

      attempted += 1;
      try {
        const fetched = await fetchProvider.fetchPage(url);
        if (!fetched.content.trim()) {
          return context;
        }
        succeeded += 1;
        return {
          ...context,
          title: fetched.title || context.title,
          content: fetched.content,
          score: Math.min(1, context.score + 0.05),
          metadata: {
            ...context.metadata,
            url: fetched.url,
            links: fetched.links,
            webFetch: 'fetched',
            fetchedAt: fetched.retrievedAt,
            fetchedProvider: fetched.provider,
            searchSnippet: context.content,
          },
        };
      } catch (error) {
        failed += 1;
        return {
          ...context,
          metadata: {
            ...context.metadata,
            webFetch: 'failed',
            webFetchError: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }),
  );

  return {
    contexts,
    attempted,
    succeeded,
    failed,
  };
}

interface PackedContexts {
  contexts: RetrievedContext[];
  maxContextTokens: number;
  usedContextTokens: number;
  truncatedContextCount: number;
  omittedContextCount: number;
}

function packContexts(contexts: RetrievedContext[], maxContextTokens: number): PackedContexts {
  const maxTokens = Math.max(1, Math.floor(maxContextTokens));
  let remainingTokens = maxTokens;
  let truncatedContextCount = 0;
  let omittedContextCount = 0;
  const packed: RetrievedContext[] = [];

  for (const context of contexts) {
    const estimatedTokens = estimateTextTokens(context.content);
    if (estimatedTokens <= remainingTokens) {
      packed.push({
        ...context,
        metadata: {
          ...context.metadata,
          packedTokenEstimate: estimatedTokens,
        },
      });
      remainingTokens -= estimatedTokens;
      continue;
    }

    if (remainingTokens <= 0) {
      omittedContextCount += 1;
      continue;
    }

    const content = trimToEstimatedTokens(context.content, remainingTokens);
    if (!content.trim()) {
      omittedContextCount += 1;
      continue;
    }

    const packedTokenEstimate = estimateTextTokens(content);
    packed.push({
      ...context,
      content,
      metadata: {
        ...context.metadata,
        truncated: true,
        originalTokenEstimate: estimatedTokens,
        packedTokenEstimate,
      },
    });
    truncatedContextCount += 1;
    remainingTokens -= packedTokenEstimate;
  }

  return {
    contexts: packed,
    maxContextTokens: maxTokens,
    usedContextTokens: packed.reduce((total, context) => total + estimateTextTokens(context.content), 0),
    truncatedContextCount,
    omittedContextCount,
  };
}

function trimToEstimatedTokens(text: string, maxTokens: number): string {
  const maxCharacters = Math.max(1, maxTokens * 4);
  if (text.length <= maxCharacters) {
    return text;
  }

  return text.slice(0, maxCharacters).trimEnd();
}

function isWebFetchProvider(provider: RagProvider): provider is WebFetchProvider {
  return provider.id === 'web-search' && typeof (provider as Partial<WebFetchProvider>).fetchPage === 'function';
}

function isSourceBackedPrompt(text: string): boolean {
  const normalized = text.toLowerCase();
  return [
    'current',
    'latest',
    'recent',
    'today',
    'yesterday',
    'tomorrow',
    'web search',
    'search the web',
    'official',
    'source',
    'url',
    'link',
    'citation',
    'docs url',
    'api docs',
  ].some((term) => normalized.includes(term));
}

function isProjectDocumentPrompt(text: string): boolean {
  const normalized = text.toLowerCase();
  return [
    'our docs',
    'project docs',
    'company docs',
    'document index',
    'knowledge base',
    'uploaded document',
  ].some((term) => normalized.includes(term));
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
