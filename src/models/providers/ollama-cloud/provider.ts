import { registerProvider } from '@flue/runtime';
import { providerContextWindow } from '../../card-limits.js';
import { resolveProviderCardEnv } from '../../env.js';
import { ollamaCloudProviderId } from '../../provider-ids.js';
import type { AgentModelProfile } from '../../types.js';
import { ollamaCloudCards } from './cards/index.js';

export const ollamaCloudDefaultBaseUrl = 'https://ollama.com/v1';

export function registerOllamaCloudProvider(
  env: Record<string, unknown> = process.env,
  cards: readonly AgentModelProfile[] = ollamaCloudCards,
): void {
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
