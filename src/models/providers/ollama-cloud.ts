import { registerProvider } from '@flue/runtime';
import { ollamaCloudCards, providerContextWindow } from '../cards/index.js';
import { ollamaCloudProviderId } from '../provider-ids.js';
import type { AgentModelProfile } from '../types.js';

export const ollamaCloudDefaultBaseUrl = 'https://ollama.com/v1';

export function registerOllamaCloudProvider(
  env: Record<string, unknown>,
  cards: readonly AgentModelProfile[] = ollamaCloudCards,
): void {
  const apiKey = readString(env.OLLAMA_API_KEY) ?? readString(env.OLLAMA_CLOUD_API_KEY);
  if (!apiKey) {
    return;
  }

  registerProvider(ollamaCloudProviderId, {
    api: 'openai-completions',
    baseUrl: readString(env.OLLAMA_CLOUD_BASE_URL) ?? ollamaCloudDefaultBaseUrl,
    apiKey,
    contextWindow: Math.max(...cards.map(providerContextWindow)),
    maxTokens: Math.max(...cards.map((card) => card.maxOutputTokens)),
    models: Object.fromEntries(
      cards.map((card) => [
        card.modelId,
        {
          contextWindow: providerContextWindow(card),
          maxTokens: card.maxOutputTokens,
        },
      ]),
    ),
  });
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
