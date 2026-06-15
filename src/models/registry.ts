import {
  codexBrainCard,
  deepseekV4ProCard,
  kimik27codeCard,
  minimaxM3Card,
  nomicEmbedTextCloudCard,
  nomicEmbedTextLocalCard,
  qwen35Card,
} from './catalog.js';
import { loadGoromboConfig, type LoadGoromboConfigOptions } from '../config/index.js';
import { resolveModelCardEnv } from './env.js';
import { codexBrainProviderId, ollamaCloudProviderId } from './provider-ids.js';
import type { AgentModelCard, ModelRegistry, ModelRole } from './types.js';

export interface ModelRegistryOptions extends LoadGoromboConfigOptions {}

export function configureRuntimeModels(
  env: Record<string, unknown>,
  options: ModelRegistryOptions = {},
): ModelRegistry {
  const cards = createModelCards();
  const registry = createModelRegistry(env, cards, options);
  validateConfiguredModels(env, registry);

  return registry;
}

export function createModelRegistry(
  env: Record<string, unknown>,
  cards: AgentModelCard[] = createModelCards(),
  options: ModelRegistryOptions = {},
): ModelRegistry {
  assertNoModelChoiceEnv(env);
  const config = loadGoromboConfig(options);
  const byKey = new Map(cards.filter((card) => card.enabled).map((card) => [card.key, card]));
  const selectedModelCard = resolveConfiguredModelCard(config.models.primary, 'models.primary', byKey);
  const backupModelCard = config.models.backup
    ? resolveConfiguredModelCard(config.models.backup, 'models.backup', byKey)
    : undefined;

  if (backupModelCard && backupModelCard.key === selectedModelCard.key) {
    throw new Error(
      `GOROMBO config models.backup must be different from models.primary; both are "${selectedModelCard.key}".`,
    );
  }

  return {
    selectedModelCard,
    ...(backupModelCard ? { backupModelCard } : {}),
    modelCandidates: backupModelCard ? [selectedModelCard, backupModelCard] : [selectedModelCard],
    cards: [...byKey.values()],
    byKey,
  };
}

export function selectModelCardForRole(registry: ModelRegistry, role: ModelRole): AgentModelCard {
  const card = registry.cards.find((candidate) => candidate.roles.includes(role));
  if (!card) {
    throw new Error(`No model card is configured for role: ${role}`);
  }

  return card;
}

function createModelCards(): AgentModelCard[] {
  return [
    minimaxM3Card,
    deepseekV4ProCard,
    qwen35Card,
    kimik27codeCard,
    codexBrainCard,
    nomicEmbedTextCloudCard,
    nomicEmbedTextLocalCard,
  ];
}

function validateConfiguredModels(env: Record<string, unknown>, registry: ModelRegistry): void {
  for (const card of registry.modelCandidates) {
    validateModelCardProviderEnv(env, card);
  }
}

function validateModelCardProviderEnv(env: Record<string, unknown>, card: AgentModelCard): void {
  const providerId = card.providerId;
  const cloudKey = resolveModelCardEnv(card, env).apiKey;

  if (providerId === ollamaCloudProviderId && !cloudKey) {
    throw new Error('OLLAMA_API_KEY or OLLAMA_CLOUD_API_KEY is required for Ollama Cloud model cards.');
  }

  if (providerId === codexBrainProviderId) {
    const resolved = resolveModelCardEnv(card, env);
    if (!resolved.apiKey || !resolved.baseUrl) {
      throw new Error('CODEX_BRAIN_LOCAL_API_KEY and CODEX_BRAIN_LOCAL_API_URL are required for the Codex Brain model card.');
    }
  }
}

function resolveConfiguredModelCard(
  modelKey: string,
  configField: 'models.primary' | 'models.backup',
  byKey: Map<string, AgentModelCard>,
): AgentModelCard {
  const card = byKey.get(modelKey);
  if (card) {
    return card;
  }

  throw new Error(
    `No model card named "${modelKey}" is configured for ${configField}. Use one of: ${[
      ...byKey.keys(),
    ].join(', ')}`,
  );
}

function assertNoModelChoiceEnv(env: Record<string, unknown>): void {
  const deprecated = ['GOROMBO_MODEL', 'GOROMBO_MODEL_BACKUP'].filter((key) => readString(env[key]));
  if (deprecated.length) {
    throw new Error(
      `${deprecated.join(', ')} ${deprecated.length === 1 ? 'is' : 'are'} no longer supported. ` +
        'Choose model card keys in the shipped gorombo.config.json runtime config and keep only secrets in .env.',
    );
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
