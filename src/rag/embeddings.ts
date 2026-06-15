import { allModelCards } from '../models/catalog.js';
import { resolveModelCardEnv } from '../models/env.js';
import type { AgentModelCard } from '../models/types.js';
import { estimateTextTokens } from '../session/context-budget.js';

export interface EmbeddingClient {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

export interface CreateEmbeddingClientOptions {
  env?: Record<string, unknown>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const defaultEmbeddingTimeoutMs = 30_000;
const maxEmbeddingTokens = 8_192;

export function createEmbeddingClient(options: CreateEmbeddingClientOptions = {}): EmbeddingClient {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? readPositiveInteger(env.GOROMBO_EMBEDDING_TIMEOUT_MS) ?? defaultEmbeddingTimeoutMs;
  const cards = resolveEmbeddingCards();

  return {
    async embed(text: string): Promise<number[]> {
      const results = await embedBatchInternal([text], cards, fetchImpl, timeoutMs);
      return results[0] ?? [];
    },
    async embedBatch(texts: string[]): Promise<number[][]> {
      return embedBatchInternal(texts, cards, fetchImpl, timeoutMs);
    },
  };
}

function resolveEmbeddingCards(): AgentModelCard[] {
  const allCards = [...allModelCards].filter((card) => card.roles.includes('embedding'));
  const local = allCards.filter((card) => card.capabilities.includes('local'));
  const cloud = allCards.filter((card) => card.capabilities.includes('cloud'));

  // Prefer local first, then cloud. Within each group, keep registry order.
  return [...local, ...cloud];
}

async function embedBatchInternal(
  texts: string[],
  cards: AgentModelCard[],
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<number[][]> {
  if (!cards.length) {
    throw new Error('No embedding model card is configured. Add an embedding role card such as nomic-embed-text.');
  }

  const truncated = texts.map((text) => truncateToEmbeddingBudget(text));
  const errors: string[] = [];

  for (const card of cards) {
    const resolved = resolveModelCardEnv(card, process.env);
    const apiKey = resolved.apiKey;
    const baseUrl = resolved.baseUrl ?? defaultBaseUrlForProvider(card.providerId);

    if (!apiKey) {
      errors.push(`${card.specifier}: missing API key`);
      continue;
    }

    try {
      return await callEmbeddingsEndpoint({
        baseUrl,
        apiKey,
        modelId: card.modelId,
        texts: truncated,
        fetchImpl,
        timeoutMs,
      });
    } catch (error) {
      errors.push(`${card.specifier}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`Embedding request failed for all configured cards. ${errors.join('; ')}`);
}

function defaultBaseUrlForProvider(providerId: string): string {
  if (providerId === 'ollama-local') {
    return 'http://localhost:11434/v1';
  }

  if (providerId === 'ollama-cloud') {
    return 'https://ollama.com/v1';
  }

  throw new Error(`No default base URL for embedding provider ${providerId}.`);
}

interface CallEmbeddingsInput {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  texts: string[];
  fetchImpl: typeof fetch;
  timeoutMs: number;
}

async function callEmbeddingsEndpoint(input: CallEmbeddingsInput): Promise<number[][]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);

  try {
    const response = await input.fetchImpl(`${trimTrailingSlash(input.baseUrl)}/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: input.modelId,
        input: input.texts,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`embeddings endpoint returned ${response.status}`);
    }

    const body = (await response.json()) as unknown;
    return parseEmbeddingsResponse(body, input.texts.length);
  } finally {
    clearTimeout(timer);
  }
}

function parseEmbeddingsResponse(body: unknown, expectedCount: number): number[][] {
  if (!body || typeof body !== 'object' || !('data' in body)) {
    throw new Error('embeddings response missing data field');
  }

  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length !== expectedCount) {
    throw new Error(`embeddings response data length ${Array.isArray(data) ? data.length : 'none'} does not match request count ${expectedCount}`);
  }

  return data.map((item, index) => {
    if (!item || typeof item !== 'object' || !('embedding' in item)) {
      throw new Error(`embeddings response missing embedding at index ${index}`);
    }

    const embedding = (item as { embedding?: unknown }).embedding;
    if (!Array.isArray(embedding) || !embedding.every((value) => typeof value === 'number' && Number.isFinite(value))) {
      throw new Error(`embeddings response has invalid embedding at index ${index}`);
    }

    return embedding as number[];
  });
}

function truncateToEmbeddingBudget(text: string): string {
  const estimatedTokens = estimateTextTokens(text);
  if (estimatedTokens <= maxEmbeddingTokens) {
    return text;
  }

  const maxCharacters = Math.max(1, maxEmbeddingTokens * 4);
  return text.slice(0, maxCharacters).trimEnd();
}

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
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
