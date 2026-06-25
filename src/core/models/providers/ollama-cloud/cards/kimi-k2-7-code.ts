import { ollamaCloudProviderId } from '../../../../../core/models/provider-ids.js';
import type { AgentModelCard } from '../../../../../core/models/types.js';

export const kimik27codeCard: AgentModelCard = {
  key: 'kimi-k2.7-code-cloud',
  providerId: ollamaCloudProviderId,
  modelId: 'kimi-k2.7-code:cloud',
  specifier: `${ollamaCloudProviderId}/kimi-k2.7-code:cloud`,
  displayName: 'Kimi K2.7 Code Cloud',
  description:
    'Ollama Cloud Kimi K2.7 Code model with vision, tool use, and thinking for agentic coding tasks.',
  roles: ['agentic-chat', 'tool-use', 'coding', 'rag', 'protocol-reasoning'],
  capabilities: ['tools', 'thinking', 'coding', 'long-context', 'vision', 'cloud'],
  contextWindow: 1_000_000,
  guaranteedContextWindow: 256_000,
  providerReportedContextWindow: 262_144,
  maxOutputTokens: 32_768,
  maxTokens: 32_768,
  enabled: true,
  env: {
    apiKey: ['OLLAMA_API_KEY', 'OLLAMA_CLOUD_API_KEY'],
    baseUrl: 'OLLAMA_CLOUD_BASE_URL',
  },
  source: {
    name: 'Ollama Cloud /api/show and Kimi API Platform docs',
    url: 'https://ollama.com/library/kimi-k2.7-code',
    checkedAt: '2026-06-07',
    notes:
      'Ollama Cloud reports 256K context for kimi-k2.7-code:cloud. Moonshot documents a 1M token context window and a 32,768 default max_tokens for the K2.7 Code family.',
  },
};
