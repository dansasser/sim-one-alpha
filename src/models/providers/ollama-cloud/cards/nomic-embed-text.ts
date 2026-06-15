import { ollamaCloudProviderId } from '../../../provider-ids.js';
import type { AgentModelCard } from '../../../types.js';

export const nomicEmbedTextCloudCard: AgentModelCard = {
  key: 'nomic-embed-text-cloud',
  providerId: ollamaCloudProviderId,
  modelId: 'nomic-embed-text',
  specifier: `${ollamaCloudProviderId}/nomic-embed-text`,
  displayName: 'Nomic Embed Text (Ollama Cloud)',
  description: 'Cloud embedding model via Ollama Cloud. 768 dimensions, 8192 token context.',
  roles: ['embedding'],
  capabilities: ['embedding', 'cloud'],
  contextWindow: 8_192,
  maxOutputTokens: 768,
  maxTokens: 768,
  enabled: true,
  env: {
    apiKey: ['OLLAMA_API_KEY', 'OLLAMA_CLOUD_API_KEY'],
    baseUrl: 'OLLAMA_CLOUD_BASE_URL',
  },
  source: {
    name: 'Ollama Cloud /v1/embeddings',
    checkedAt: '2026-06-14',
    notes: 'Ollama Cloud embeddings endpoint is OpenAI-compatible at /v1/embeddings.',
  },
};
