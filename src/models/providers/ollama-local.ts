import { registerProvider } from '@flue/runtime';
import { ollamaLocalProviderId } from '../provider-ids.js';
import type { AgentModelProfile } from '../types.js';

export const ollamaLocalDefaultBaseUrl = 'http://localhost:11434/v1';

export function registerOllamaLocalProvider(
  env: Record<string, unknown>,
  cards: readonly AgentModelProfile[] = [],
): void {
  if (!shouldRegisterLocalProvider(env, cards)) {
    return;
  }

  registerProvider(ollamaLocalProviderId, {
    api: 'openai-completions',
    baseUrl: readString(env.OLLAMA_LOCAL_BASE_URL) ?? ollamaLocalDefaultBaseUrl,
    apiKey: readString(env.OLLAMA_LOCAL_API_KEY) ?? 'ollama',
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
  });
}

function shouldRegisterLocalProvider(env: Record<string, unknown>, cards: readonly AgentModelProfile[]): boolean {
  return Boolean(
    cards.length ||
      readString(env.OLLAMA_LOCAL_BASE_URL) ||
      readString(env.OLLAMA_LOCAL_API_KEY) ||
      readString(env.OLLAMA_CODEX_BRAIN_MODEL),
  );
}

function maxOrDefault(values: number[], fallback: number): number {
  return values.length ? Math.max(...values) : fallback;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
