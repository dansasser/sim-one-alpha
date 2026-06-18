import { allModelCards } from '../models/catalog.js';
import { resolveModelCardEnv } from '../models/env.js';
import { onnxLocalProviderId } from '../models/provider-ids.js';
import type { AgentModelCard } from '../models/types.js';
import { estimateTextTokens } from '../session/context-budget.js';
import { embedBatch as embedBatchOnnxLocal } from '../embeddings/index.js';

export interface EmbeddingClient {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  embedWithOutcome(text: string): Promise<EmbedOutcome>;
  embedBatchWithOutcome(texts: string[]): Promise<EmbedBatchOutcome>;
}

export type EmbeddingResult = {
  readonly vector: number[];
  readonly provider: 'onnx-local' | 'cloud' | 'local';
  readonly modelId: string;
};

export type EmbedBatchResult = {
  readonly vectors: number[][];
  readonly provider: 'onnx-local' | 'cloud' | 'local';
  readonly modelId: string;
};

export type EmbedOutcome =
  | { readonly ok: true; readonly result: EmbeddingResult }
  | { readonly ok: false; readonly error: string };

export type EmbedBatchOutcome =
  | { readonly ok: true; readonly result: EmbedBatchResult }
  | { readonly ok: false; readonly error: string };


export interface CreateEmbeddingClientOptions {
  env?: Record<string, unknown>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const defaultEmbeddingTimeoutMs = 30_000;
const maxEmbeddingTokens = 8_192;

const loggedCloudFailures = new Set<string>();
const loggedOnnxFailures = new Set<string>();
const loggedLocalFailures = new Set<string>();

export function createEmbeddingClient(options: CreateEmbeddingClientOptions = {}): EmbeddingClient {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? readPositiveInteger(env.GOROMBO_EMBEDDING_TIMEOUT_MS) ?? defaultEmbeddingTimeoutMs;
  const cards = resolveEmbeddingCards();

  return {
    async embed(text: string): Promise<number[]> {
      const results = await embedBatchInternal([text], cards, fetchImpl, timeoutMs, env);
      return results[0] ?? [];
    },
    async embedBatch(texts: string[]): Promise<number[][]> {
      return embedBatchInternal(texts, cards, fetchImpl, timeoutMs, env);
    },
    async embedWithOutcome(text: string): Promise<EmbedOutcome> {
      return toOutcome(embedBatchInternal([text], cards, fetchImpl, timeoutMs, env, { captureProvider: true }));
    },
    async embedBatchWithOutcome(texts: string[]): Promise<EmbedBatchOutcome> {
      return toBatchOutcome(embedBatchInternal(texts, cards, fetchImpl, timeoutMs, env, { captureProvider: true }));
    },
  };
}

function resolveEmbeddingCards(): AgentModelCard[] {
  const allCards = [...allModelCards].filter((card) => card.roles.includes('embedding'));
  const cloud = allCards.filter((card) => card.capabilities.includes('cloud'));
  const onnxLocal = allCards.filter((card) => card.providerId === onnxLocalProviderId);
  const local = allCards.filter(
    (card) => card.capabilities.includes('local') && card.providerId !== onnxLocalProviderId,
  );

  // Cloud first, then bundled local ONNX, then legacy local Ollama.
  return [...cloud, ...onnxLocal, ...local];
}

async function embedBatchInternal(
  texts: string[],
  cards: AgentModelCard[],
  fetchImpl: typeof fetch,
  timeoutMs: number,
  env?: Record<string, unknown>,
  options?: { captureProvider?: boolean },
): Promise<number[][]> {
  if (!cards.length) {
    throw new Error('No embedding model card is configured. Add an embedding role card such as nomic-embed-text.');
  }

  const truncated = texts.map((text) => truncateToEmbeddingBudget(text));
  const errors: string[] = [];

  for (const card of cards) {
    try {
      if (card.providerId === onnxLocalProviderId) {
        if (options?.captureProvider) {
          lastSuccessProvider = { provider: 'onnx-local', modelId: card.modelId };
        }
        return await callOnnxLocalEmbeddings({ texts: truncated, card });
      }

      const resolved = resolveModelCardEnv(card, env ?? process.env);
      const apiKey = resolved.apiKey;
      const baseUrl = resolved.baseUrl ?? defaultBaseUrlForProvider(card.providerId);

      const effectiveApiKey = apiKey ?? (card.providerId === 'ollama-local' ? 'ollama' : undefined);
      if (!effectiveApiKey) {
        errors.push(`${card.specifier}: missing API key`);
        continue;
      }

      if (card.providerId === 'ollama-cloud') {
        if (options?.captureProvider) {
          lastSuccessProvider = { provider: 'cloud', modelId: card.modelId };
        }
        return await callCloudEmbeddings({
          baseUrl,
          apiKey: effectiveApiKey,
          modelId: card.modelId,
          texts: truncated,
          fetchImpl,
          timeoutMs,
        });
      }

      if (options?.captureProvider) {
        lastSuccessProvider = { provider: 'local', modelId: card.modelId };
      }
      return await callLegacyLocalEmbeddings({
        baseUrl,
        apiKey: effectiveApiKey,
        modelId: card.modelId,
        texts: truncated,
        fetchImpl,
        timeoutMs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logProviderFailure(card, message);
      errors.push(`${card.specifier}: ${message}`);
    }
  }

  throw new Error(`Embedding request failed for all configured cards. ${errors.join('; ')}`);
}

function logProviderFailure(card: AgentModelCard, message: string): void {
  if (card.providerId === 'ollama-cloud') {
    if (!loggedCloudFailures.has(card.specifier)) {
      loggedCloudFailures.add(card.specifier);
      console.error(`[WARN] embedding.cloud.unavailable provider=${card.specifier} error=${message}`);
    }
    return;
  }

  if (card.providerId === onnxLocalProviderId) {
    if (!loggedOnnxFailures.has(card.specifier)) {
      loggedOnnxFailures.add(card.specifier);
      console.error(`[WARN] embedding.onnx-local.unavailable provider=${card.specifier} error=${message}`);
    }
    return;
  }

  if (card.providerId === 'ollama-local') {
    if (!loggedLocalFailures.has(card.specifier)) {
      loggedLocalFailures.add(card.specifier);
      console.error(`[WARN] embedding.local.unavailable provider=${card.specifier} error=${message}`);
    }
  }
}

interface CallEmbeddingsInput {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  texts: string[];
  fetchImpl: typeof fetch;
  timeoutMs: number;
}

async function callCloudEmbeddings(input: CallEmbeddingsInput): Promise<number[][]> {
  return callEmbeddingsEndpoint({ ...input, path: '/api/embed', responseField: 'embeddings' });
}

async function callLegacyLocalEmbeddings(input: CallEmbeddingsInput): Promise<number[][]> {
  return callEmbeddingsEndpoint({ ...input, path: '/v1/embeddings', responseField: 'data' });
}

interface CallEmbeddingsEndpointInput extends CallEmbeddingsInput {
  path: string;
  responseField: 'embeddings' | 'data';
}

async function callEmbeddingsEndpoint(input: CallEmbeddingsEndpointInput): Promise<number[][]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);

  const body =
    input.responseField === 'embeddings'
      ? { model: input.modelId, input: input.texts }
      : { model: input.modelId, input: input.texts };

  try {
    const response = await input.fetchImpl(`${trimTrailingSlash(input.baseUrl)}${input.path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`embeddings endpoint returned ${response.status}`);
    }

    const responseBody = (await response.json()) as unknown;
    return parseEmbeddingsResponse(responseBody, input.texts.length, input.responseField);
  } finally {
    clearTimeout(timer);
  }
}

interface CallOnnxLocalEmbeddingsInput {
  texts: string[];
  card: AgentModelCard;
}

async function callOnnxLocalEmbeddings(input: CallOnnxLocalEmbeddingsInput): Promise<number[][]> {
  try {
    return await embedBatchOnnxLocal(input.texts);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`onnx-local embedding failed: ${message}`);
  }
}

function parseEmbeddingsResponse(body: unknown, expectedCount: number, responseField: 'embeddings' | 'data'): number[][] {
  if (!body || typeof body !== 'object') {
    throw new Error('embeddings response missing data field');
  }

  if (responseField === 'embeddings') {
    if (!('embeddings' in body)) {
      throw new Error('embeddings response missing embeddings field');
    }
    const embeddings = (body as { embeddings?: unknown }).embeddings;
    if (!Array.isArray(embeddings) || embeddings.length !== expectedCount) {
      throw new Error(
        `embeddings response embeddings length ${Array.isArray(embeddings) ? embeddings.length : 'none'} does not match request count ${expectedCount}`,
      );
    }
    return embeddings.map((embedding, index) => assertValidEmbedding(embedding, index));
  }

  if (!('data' in body)) {
    throw new Error('embeddings response missing data field');
  }

  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length !== expectedCount) {
    throw new Error(
      `embeddings response data length ${Array.isArray(data) ? data.length : 'none'} does not match request count ${expectedCount}`,
    );
  }

  return data.map((item, index) => {
    if (!item || typeof item !== 'object' || !('embedding' in item)) {
      throw new Error(`embeddings response missing embedding at index ${index}`);
    }
    return assertValidEmbedding((item as { embedding?: unknown }).embedding, index);
  });
}

function assertValidEmbedding(embedding: unknown, index: number): number[] {
  if (!Array.isArray(embedding) || !embedding.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    throw new Error(`embeddings response has invalid embedding at index ${index}`);
  }
  return embedding as number[];
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



let lastSuccessProvider: { provider: 'onnx-local' | 'cloud' | 'local'; modelId: string } | undefined;

async function toOutcome(promise: Promise<number[][]>, card?: AgentModelCard): Promise<EmbedOutcome> {
  try {
    const vectors = await promise;
    const meta = card ? providerMetaFromCard(card) : (lastSuccessProvider ?? { provider: 'onnx-local', modelId: 'all-minilm-l6-v2' });
    lastSuccessProvider = meta;
    return { ok: true, result: { vector: vectors[0] ?? [], ...meta } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function toBatchOutcome(promise: Promise<number[][]>, card?: AgentModelCard): Promise<EmbedBatchOutcome> {
  try {
    const vectors = await promise;
    const meta = card ? providerMetaFromCard(card) : (lastSuccessProvider ?? { provider: 'onnx-local', modelId: 'all-minilm-l6-v2' });
    lastSuccessProvider = meta;
    return { ok: true, result: { vectors, ...meta } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function providerMetaFromCard(card: AgentModelCard): { provider: 'onnx-local' | 'cloud' | 'local'; modelId: string } {
  if (card.providerId === 'ollama-cloud') {
    return { provider: 'cloud', modelId: card.modelId };
  }
  if (card.providerId === 'ollama-local') {
    return { provider: 'local', modelId: card.modelId };
  }
  return { provider: 'onnx-local', modelId: card.modelId };
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
