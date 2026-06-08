import { registerProvider } from '@flue/runtime';
import { providerContextWindow } from '../../card-limits.js';
import { resolveProviderCardEnv } from '../../env.js';
import { codexBrainProviderId } from '../../provider-ids.js';
import type { AgentModelProfile } from '../../types.js';
import { codexBrainCards } from './cards/index.js';

export function registerCodexBrainProvider(
  env: Record<string, unknown> = process.env,
  cards: readonly AgentModelProfile[] = codexBrainCards,
): void {
  const resolvedEnv = resolveProviderCardEnv(cards, env);
  if (!resolvedEnv.apiKey || !resolvedEnv.baseUrl) {
    return;
  }

  registerProvider(codexBrainProviderId, {
    api: 'openai-completions',
    baseUrl: resolvedEnv.baseUrl,
    apiKey: resolvedEnv.apiKey,
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
