import { onnxLocalProviderId } from '../../../provider-ids.js';
import type { AgentModelCard } from '../../../types.js';

export const allMiniLmL6V2OnnxCard: AgentModelCard = {
  key: 'all-minilm-l6-v2-onnx',
  providerId: onnxLocalProviderId,
  modelId: 'all-minilm-l6-v2',
  specifier: `${onnxLocalProviderId}/all-minilm-l6-v2`,
  displayName: 'all-MiniLM-L6-v2 (ONNX Local)',
  description:
    'Bundled ONNX embedding model running in-process. 384 dimensions, 256 token context, English-only. No API key, no external service.',
  roles: ['embedding'],
  capabilities: ['embedding', 'local'],
  contextWindow: 256,
  maxOutputTokens: 384,
  maxTokens: 384,
  enabled: true,
  env: {},
  source: {
    name: 'Bundled ONNX all-MiniLM-L6-v2',
    checkedAt: '2026-06-17',
    notes: 'Quantized ONNX model bundled with the agent. Runs in-process via onnxruntime-node.',
  },
};
