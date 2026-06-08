import { codexBrainCard, deepseekV4ProCard, minimaxM3Card, qwen35Card } from './catalog.js';
import { resolveModelCardEnv } from './env.js';
import { codexBrainProviderId, ollamaCloudProviderId } from './provider-ids.js';
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
    codexBrainCard,
  ];
}

function readProviderId(modelSpecifier: string): string | undefined {
  const slashIndex = modelSpecifier.indexOf('/');
  return slashIndex > 0 ? modelSpecifier.slice(0, slashIndex) : undefined;
}

function validateSelectedModel(env: Record<string, unknown>, registry: ModelRegistry): void {
  const providerId = readProviderId(registry.defaultAgentModel);
  const profile = registry.profiles.find((candidate) => candidate.specifier === registry.defaultAgentModel);
  const cloudKey = profile ? resolveModelCardEnv(profile, env).apiKey : undefined;

  if (providerId === ollamaCloudProviderId && !cloudKey) {
    throw new Error('OLLAMA_API_KEY or OLLAMA_CLOUD_API_KEY is required for Ollama Cloud model profiles.');
  }

  if (providerId === codexBrainProviderId) {
    const resolved = profile ? resolveModelCardEnv(profile, env) : {};
    if (!resolved.apiKey || !resolved.baseUrl) {
      throw new Error('CODEX_BRAIN_LOCAL_API_KEY and CODEX_BRAIN_LOCAL_API_URL are required for Codex Brain profiles.');
    }
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
