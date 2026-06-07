import type { AgentModelProfile } from './types.js';

export const ollamaCloudProviderId = 'ollama-cloud';
export const ollamaLocalProviderId = 'ollama-local';
export const ollamaCloudDefaultBaseUrl = 'https://ollama.com/v1';
export const ollamaLocalDefaultBaseUrl = 'http://localhost:11434/v1';

export const minimaxM3Cloud: AgentModelProfile = createOllamaCloudProfile({
  key: 'minimax-m3-cloud',
  modelId: 'minimax-m3',
  displayName: 'MiniMax M3 Cloud',
  description: 'Current default for agentic chat, tool-use, coding, and long-context orchestration.',
  roles: ['agentic-chat', 'tool-use', 'coding', 'rag', 'protocol-reasoning'],
  capabilities: ['tools', 'thinking', 'coding', 'long-context', 'cloud'],
  contextWindow: 1000000,
  maxTokens: 40000,
});

export const deepseekV4ProCloud: AgentModelProfile = createOllamaCloudProfile({
  key: 'deepseek-v4-pro-cloud',
  modelId: 'deepseek-v4-pro',
  displayName: 'DeepSeek V4 Pro Cloud',
  description: 'Alternative cloud reasoning and coding model for comparison or fallback testing.',
  roles: ['agentic-chat', 'tool-use', 'coding', 'protocol-reasoning'],
  capabilities: ['tools', 'thinking', 'coding', 'cloud'],
  contextWindow: 128000,
  maxTokens: 32000,
});

export function createCodexBrainProfile(modelId: string): AgentModelProfile {
  return createOllamaLocalProfile({
    key: 'codex-brain',
    modelId,
    displayName: 'Local Codex Brain',
    description: 'User-hosted Ollama-compatible Codex Brain model, expected to be served from local or DT1 infrastructure.',
    roles: ['agentic-chat', 'tool-use', 'coding', 'rag', 'memory-synthesis'],
    capabilities: ['tools', 'thinking', 'coding', 'long-context', 'local'],
    contextWindow: 128000,
    maxTokens: 32000,
  });
}

function createOllamaCloudProfile(
  profile: Omit<AgentModelProfile, 'providerId' | 'specifier' | 'enabled'>,
): AgentModelProfile {
  return createOllamaProfile(ollamaCloudProviderId, profile);
}

function createOllamaLocalProfile(
  profile: Omit<AgentModelProfile, 'providerId' | 'specifier' | 'enabled'>,
): AgentModelProfile {
  return createOllamaProfile(ollamaLocalProviderId, profile);
}

function createOllamaProfile(
  providerId: string,
  profile: Omit<AgentModelProfile, 'providerId' | 'specifier' | 'enabled'>,
): AgentModelProfile {
  return {
    ...profile,
    providerId,
    specifier: `${providerId}/${profile.modelId}`,
    enabled: true,
  };
}
