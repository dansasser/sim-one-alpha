import { ollamaCloudProviderId } from '../../../provider-ids.js';
import type { AgentModelCard } from '../../../types.js';

export const qwen35Card: AgentModelCard = {
  key: 'qwen3-5-cloud',
  providerId: ollamaCloudProviderId,
  modelId: 'qwen3.5:397b',
  specifier: `${ollamaCloudProviderId}/qwen3.5:397b`,
  displayName: 'Qwen 3.5 397B Cloud',
  description: 'Latest Qwen 3.5 cloud model available in Ollama Cloud, with tool use, thinking, and vision support.',
  roles: ['agentic-chat', 'tool-use', 'coding', 'rag', 'protocol-reasoning'],
  capabilities: ['tools', 'thinking', 'coding', 'long-context', 'vision', 'cloud'],
  contextWindow: 262_144,
  providerReportedContextWindow: 262_144,
  maxOutputTokens: 65_536,
  maxTokens: 65_536,
  enabled: true,
  env: {
    apiKey: ['OLLAMA_API_KEY', 'OLLAMA_CLOUD_API_KEY'],
    baseUrl: 'OLLAMA_CLOUD_BASE_URL',
  },
  source: {
    name: 'Ollama Cloud /api/show and models.dev metadata',
    checkedAt: '2026-06-07',
    notes: 'Ollama Cloud reports qwen3.5.context_length 262144 for qwen3.5:397b.',
  },
};
