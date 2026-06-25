import { ollamaLocalProviderId } from '../../../../../core/models/provider-ids.js';
import type { AgentModelCard } from '../../../../../core/models/types.js';

export const nomicEmbedTextLocalCard: AgentModelCard = {
  key: 'nomic-embed-text-local',
  providerId: ollamaLocalProviderId,
  modelId: 'nomic-embed-text',
  specifier: `${ollamaLocalProviderId}/nomic-embed-text`,
  displayName: 'Nomic Embed Text (Ollama Local)',
  description: 'Local CPU embedding model served by Ollama. 768 dimensions, 8192 token context.',
  roles: ['embedding'],
  capabilities: ['embedding', 'local'],
  contextWindow: 8_192,
  maxOutputTokens: 768,
  maxTokens: 768,
  enabled: true,
  env: {
    apiKey: 'OLLAMA_LOCAL_API_KEY',
    baseUrl: 'OLLAMA_LOCAL_BASE_URL',
  },
  source: {
    name: 'Ollama Local /api/embeddings',
    checkedAt: '2026-06-14',
    notes: 'Ollama local embeddings endpoint is OpenAI-compatible at /v1/embeddings.',
  },
};
