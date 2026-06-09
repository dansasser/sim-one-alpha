import { registerProvider } from '@flue/runtime';
import { resolveProviderCardEnv } from '../../env.js';
import { ollamaLocalProviderId } from '../../provider-ids.js';
import type { AgentModelCard } from '../../types.js';

export const ollamaLocalDefaultBaseUrl = 'http://localhost:11434/v1';

export interface OllamaLocalProviderRegistration {
  api: 'openai-completions';
  baseUrl: string;
  apiKey: string;
  contextWindow: number;
  maxTokens: number;
  models: Record<string, { contextWindow: number; maxTokens: number }>;
}

export function registerOllamaLocalProvider(
  env: Record<string, unknown> = process.env,
  cards: readonly AgentModelCard[] = [],
): void {
  const registration = resolveOllamaLocalProviderRegistration(env, cards);

  if (!registration) {
    return;
  }

  registerProvider(ollamaLocalProviderId, registration);
}

export function resolveOllamaLocalProviderRegistration(
  env: Record<string, unknown> = process.env,
  cards: readonly AgentModelCard[] = [],
): OllamaLocalProviderRegistration | undefined {
  if (!shouldRegisterLocalProvider(env, cards)) {
    return undefined;
  }

  const resolvedEnv = resolveProviderCardEnv(cards, env);

  return {
    api: 'openai-completions',
    baseUrl: resolvedEnv.baseUrl ?? readString(env.OLLAMA_LOCAL_BASE_URL) ?? ollamaLocalDefaultBaseUrl,
    apiKey: resolvedEnv.apiKey ?? readString(env.OLLAMA_LOCAL_API_KEY) ?? 'ollama',
    contextWindow: maxOrDefault(cards.map((card) => card.providerReportedContextWindow ?? card.contextWindow), 128_000),
    maxTokens: maxOrDefault(cards.map((card) => card.maxOutputTokens), 32_000),
    models: Object.fromEntries(
      cards.map((card) => [
        card.modelId,
        {
          contextWindow: card.providerReportedContextWindow ?? card.contextWindow,
          maxTokens: card.maxOutputTokens,
        },
      ]),
    ),
  };
}

function shouldRegisterLocalProvider(env: Record<string, unknown>, cards: readonly AgentModelCard[]): boolean {
  return Boolean(
    cards.length ||
      readString(env.OLLAMA_LOCAL_BASE_URL) ||
      readString(env.OLLAMA_LOCAL_API_KEY),
  );
}

function maxOrDefault(values: number[], fallback: number): number {
  return values.length ? Math.max(...values) : fallback;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
