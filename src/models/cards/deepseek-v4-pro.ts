import { ollamaCloudProviderId } from '../provider-ids.js';
import type { AgentModelProfile } from '../types.js';

export const deepseekV4ProCard: AgentModelProfile = {
  key: 'deepseek-v4-pro-cloud',
  providerId: ollamaCloudProviderId,
  modelId: 'deepseek-v4-pro',
  specifier: `${ollamaCloudProviderId}/deepseek-v4-pro`,
  displayName: 'DeepSeek V4 Pro Cloud',
  description: 'Latest DeepSeek Pro cloud reasoning model available in Ollama Cloud for agentic comparison and fallback.',
  roles: ['agentic-chat', 'tool-use', 'coding', 'protocol-reasoning'],
  capabilities: ['tools', 'thinking', 'coding', 'long-context', 'cloud'],
  contextWindow: 1_048_576,
  providerReportedContextWindow: 1_048_576,
  maxOutputTokens: 1_048_576,
  maxTokens: 1_048_576,
  enabled: true,
  source: {
    name: 'Ollama Cloud /api/show and models.dev metadata',
    checkedAt: '2026-06-07',
    notes: 'Ollama Cloud reports deepseek4.context_length 1048576 for deepseek-v4-pro.',
  },
};
