import { registerProvider } from '@flue/runtime';
import {
  createCodexBrainProfile,
  deepseekV4ProCloud,
  minimaxM3Cloud,
  ollamaCloudDefaultBaseUrl,
  ollamaCloudProviderId,
  ollamaLocalDefaultBaseUrl,
  ollamaLocalProviderId,
} from './ollama.js';
import type { AgentModelProfile, ModelRegistry, ModelRole } from './types.js';

const defaultModelProfileKey = 'minimax-m3-cloud';

export function configureRuntimeModels(env: Record<string, unknown>): ModelRegistry {
  const profiles = createModelProfiles(env);
  const registry = createModelRegistry(env, profiles);
  registerOllamaProviders(env, profiles, registry);

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
    minimaxM3Cloud,
    deepseekV4ProCloud,
    optionalCodexBrainProfile(env),
  ].filter((profile): profile is AgentModelProfile => Boolean(profile));
}

function optionalCodexBrainProfile(env: Record<string, unknown>): AgentModelProfile | undefined {
  const modelId = readString(env.OLLAMA_CODEX_BRAIN_MODEL);
  return modelId ? createCodexBrainProfile(modelId) : undefined;
}

function registerOllamaProviders(
  env: Record<string, unknown>,
  profiles: AgentModelProfile[],
  registry: ModelRegistry,
): void {
  const selectedProviderId = readProviderId(registry.defaultAgentModel);

  if (selectedProviderId === ollamaCloudProviderId || readString(env.OLLAMA_API_KEY)) {
    registerOllamaCloudProvider(env, profiles);
  }

  if (
    selectedProviderId === ollamaLocalProviderId ||
    readString(env.OLLAMA_LOCAL_BASE_URL) ||
    readString(env.OLLAMA_LOCAL_API_KEY) ||
    readString(env.OLLAMA_CODEX_BRAIN_MODEL)
  ) {
    registerOllamaLocalProvider(env, profiles);
  }
}

function registerOllamaCloudProvider(env: Record<string, unknown>, profiles: AgentModelProfile[]): void {
  const apiKey = readString(env.OLLAMA_API_KEY);
  if (!apiKey) {
    throw new Error('OLLAMA_API_KEY is required for Ollama Cloud model profiles.');
  }

  registerProvider(ollamaCloudProviderId, {
    api: 'openai-completions',
    baseUrl: readString(env.OLLAMA_CLOUD_BASE_URL) ?? ollamaCloudDefaultBaseUrl,
    apiKey,
    contextWindow: 1000000,
    maxTokens: 40000,
    models: modelsForProvider(profiles, ollamaCloudProviderId),
  });
}

function registerOllamaLocalProvider(env: Record<string, unknown>, profiles: AgentModelProfile[]): void {
  registerProvider(ollamaLocalProviderId, {
    api: 'openai-completions',
    baseUrl: readString(env.OLLAMA_LOCAL_BASE_URL) ?? ollamaLocalDefaultBaseUrl,
    apiKey: readString(env.OLLAMA_LOCAL_API_KEY) ?? 'ollama',
    contextWindow: 128000,
    maxTokens: 32000,
    models: modelsForProvider(profiles, ollamaLocalProviderId),
  });
}

function modelsForProvider(
  profiles: AgentModelProfile[],
  providerId: string,
): Record<string, { contextWindow?: number; maxTokens?: number }> {
  return Object.fromEntries(
    profiles
      .filter((profile) => profile.providerId === providerId)
      .map((profile) => [
        profile.modelId,
        {
          contextWindow: profile.contextWindow,
          maxTokens: profile.maxTokens,
        },
      ]),
  );
}

function readProviderId(modelSpecifier: string): string | undefined {
  const slashIndex = modelSpecifier.indexOf('/');
  return slashIndex > 0 ? modelSpecifier.slice(0, slashIndex) : undefined;
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
