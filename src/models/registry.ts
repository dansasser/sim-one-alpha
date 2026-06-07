import { createCodexBrainCard, deepseekV4ProCard, minimaxM3Card, qwen35Card } from './cards/index.js';
import { ollamaCloudProviderId } from './provider-ids.js';
import type { AgentModelProfile, ModelRegistry, ModelRole } from './types.js';

const defaultModelProfileKey = 'minimax-m3-cloud';

export function configureRuntimeModels(env: Record<string, unknown>): ModelRegistry {
  const profiles = createModelProfiles(env);
  const registry = createModelRegistry(env, profiles);
  validateSelectedModel(env, registry);

  return registry;
}

export function createModelRegistry(
  env: Record<string, unknown>,
  profiles: AgentModelProfile[] = createModelProfiles(env),
): ModelRegistry {
  const byKey = new Map(profiles.filter((profile) => profile.enabled).map((profile) => [profile.key, profile]));

  return {
    defaultAgentModel: resolveDefaultAgentModel(env, byKey),
    profiles: [...byKey.values()],
    byKey,
  };
}

export function selectModelForRole(registry: ModelRegistry, role: ModelRole): string {
  const profile = registry.profiles.find((candidate) => candidate.roles.includes(role));
  if (!profile) {
    throw new Error(`No model profile is configured for role: ${role}`);
  }

  return profile.specifier;
}

function createModelProfiles(env: Record<string, unknown>): AgentModelProfile[] {
  return [
    minimaxM3Card,
    deepseekV4ProCard,
    qwen35Card,
    optionalCodexBrainProfile(env),
  ].filter((profile): profile is AgentModelProfile => Boolean(profile));
}

function optionalCodexBrainProfile(env: Record<string, unknown>): AgentModelProfile | undefined {
  const modelId = readString(env.OLLAMA_CODEX_BRAIN_MODEL);
  return modelId ? createCodexBrainCard(modelId) : undefined;
}

function readProviderId(modelSpecifier: string): string | undefined {
  const slashIndex = modelSpecifier.indexOf('/');
  return slashIndex > 0 ? modelSpecifier.slice(0, slashIndex) : undefined;
}

function validateSelectedModel(env: Record<string, unknown>, registry: ModelRegistry): void {
  const providerId = readProviderId(registry.defaultAgentModel);
  const cloudKey = readString(env.OLLAMA_API_KEY) ?? readString(env.OLLAMA_CLOUD_API_KEY);

  if (providerId === ollamaCloudProviderId && !cloudKey) {
    throw new Error('OLLAMA_API_KEY or OLLAMA_CLOUD_API_KEY is required for Ollama Cloud model profiles.');
  }
}

function resolveDefaultAgentModel(env: Record<string, unknown>, byKey: Map<string, AgentModelProfile>): string {
  const explicitModel = readString(env.GOROMBO_MODEL);
  if (explicitModel) {
    return explicitModel;
  }

  const profileKey = readString(env.GOROMBO_MODEL_PROFILE) ?? defaultModelProfileKey;
  const profile = byKey.get(profileKey);
  if (profile) {
    return profile.specifier;
  }

  throw new Error(
    `No agentic model profile named "${profileKey}" is configured. Set GOROMBO_MODEL or use one of: ${[
      ...byKey.keys(),
    ].join(', ')}`,
  );
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
