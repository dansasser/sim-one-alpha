import { ollamaCloudProviderId } from '../provider-ids.js';
import type { AgentModelProfile } from '../types.js';

export const minimaxM3Card: AgentModelProfile = {
  key: 'minimax-m3-cloud',
  providerId: ollamaCloudProviderId,
  modelId: 'minimax-m3',
  specifier: `${ollamaCloudProviderId}/minimax-m3`,
  displayName: 'MiniMax M3 Cloud',
  description: 'Frontier agentic coding and multimodal model for long-context orchestration.',
  roles: ['agentic-chat', 'tool-use', 'coding', 'rag', 'protocol-reasoning'],
  capabilities: ['tools', 'thinking', 'coding', 'long-context', 'vision', 'video', 'cloud'],
  contextWindow: 1_000_000,
  guaranteedContextWindow: 512_000,
  providerReportedContextWindow: 524_288,
  maxOutputTokens: 131_072,
  maxTokens: 131_072,
  enabled: true,
  source: {
    name: 'MiniMax M3 model page and Ollama Cloud metadata',
    url: 'https://www.minimax.io/models/text/m3',
    checkedAt: '2026-06-07',
    notes:
      'MiniMax advertises up to 1M context with a guaranteed 512K minimum. Ollama Cloud currently reports 524288 through /api/show and local :cloud metadata.',
  },
};
