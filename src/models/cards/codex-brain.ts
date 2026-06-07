import { ollamaLocalProviderId } from '../provider-ids.js';
import type { AgentModelProfile } from '../types.js';

export function createCodexBrainCard(modelId: string): AgentModelProfile {
  return {
    key: 'codex-brain',
    providerId: ollamaLocalProviderId,
    modelId,
    specifier: `${ollamaLocalProviderId}/${modelId}`,
    displayName: 'Local Codex Brain',
    description: 'User-hosted Ollama-compatible Codex Brain model, expected to be served from local or DT1 infrastructure.',
    roles: ['agentic-chat', 'tool-use', 'coding', 'rag', 'memory-synthesis'],
    capabilities: ['tools', 'thinking', 'coding', 'long-context', 'local'],
    contextWindow: 128_000,
    maxOutputTokens: 32_000,
    maxTokens: 32_000,
    enabled: true,
    source: {
      name: 'Project default for local Codex Brain',
      checkedAt: '2026-06-07',
      notes: 'Override this card once DT1 exposes exact context and output limits.',
    },
  };
}
