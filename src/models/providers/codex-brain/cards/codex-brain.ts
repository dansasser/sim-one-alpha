import { codexBrainProviderId } from '../../../provider-ids.js';
import type { AgentModelCard } from '../../../types.js';

export const codexBrainCard: AgentModelCard = {
  key: 'codex-brain',
  providerId: codexBrainProviderId,
  modelId: 'gpt-5.5',
  specifier: `${codexBrainProviderId}/gpt-5.5`,
  displayName: 'Codex Brain GPT-5.5',
  description: 'Project Codex Brain API wrapper for coding, project reasoning, tool calling, and memory synthesis.',
  roles: ['agentic-chat', 'tool-use', 'coding', 'rag', 'memory-synthesis'],
  capabilities: ['tools', 'thinking', 'coding', 'long-context', 'local'],
  contextWindow: 128_000,
  maxOutputTokens: 32_000,
  maxTokens: 32_000,
  enabled: true,
  env: {
    apiKey: 'CODEX_BRAIN_LOCAL_API_KEY',
    baseUrl: 'CODEX_BRAIN_LOCAL_API_URL',
  },
  source: {
    name: 'Project Codex Brain API',
    checkedAt: '2026-06-08',
    notes:
      'OpenAI-compatible Codex Brain harness API. /v1/models returns gpt-5.5; chat uses /v1/chat/completions with cba bearer authentication.',
  },
};
