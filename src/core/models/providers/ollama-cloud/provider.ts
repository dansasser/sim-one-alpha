import { registerProvider } from '@flue/runtime';
import { providerContextWindow } from '../../../../core/models/card-limits.js';
import { resolveProviderCardEnv } from '../../../../core/models/env.js';
import { ollamaCloudProviderId } from '../../../../core/models/provider-ids.js';
import type { AgentModelCard } from '../../../../core/models/types.js';
import { ollamaCloudCards } from '../../../../core/models/providers/ollama-cloud/cards/index.js';

export const ollamaCloudDefaultBaseUrl = 'https://ollama.com/v1';

export function registerOllamaCloudProvider(
  env: Record<string, unknown> = process.env,
  cards: readonly AgentModelCard[] = ollamaCloudCards,
): void {
  if (!cards.length) {
    return;
  }

  const resolvedEnv = resolveProviderCardEnv(cards, env);
  const apiKey = resolvedEnv.apiKey;
  if (!apiKey) {
    return;
  }

  registerProvider(ollamaCloudProviderId, {
    api: 'openai-completions',
    baseUrl: resolvedEnv.baseUrl ?? ollamaCloudDefaultBaseUrl,
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
