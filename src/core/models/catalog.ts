export { providerContextWindow } from '../../core/models/card-limits.js';
export { codexBrainCard, codexBrainCards } from '../../core/models/providers/codex-brain/index.js';
export {
  deepseekV4ProCard,
  kimik27codeCard,
  minimaxM3Card,
  nomicEmbedTextCloudCard,
  ollamaCloudCards,
  qwen35Card,
} from '../../core/models/providers/ollama-cloud/index.js';
export { nomicEmbedTextLocalCard, ollamaLocalCards } from '../../core/models/providers/ollama-local/index.js';
export { allMiniLmL6V2OnnxCard, onnxLocalCards } from '../../core/models/providers/onnx-local/index.js';

import { codexBrainCards } from '../../core/models/providers/codex-brain/index.js';
import { ollamaCloudCards } from '../../core/models/providers/ollama-cloud/index.js';
import { ollamaLocalCards } from '../../core/models/providers/ollama-local/index.js';
import { onnxLocalCards } from '../../core/models/providers/onnx-local/index.js';
import type { AgentModelCard } from '../../core/models/types.js';

export const allModelCards = [
  ...ollamaCloudCards,
  ...codexBrainCards,
  ...ollamaLocalCards,
  ...onnxLocalCards,
] as const;

export function resolveModelCard(specifier: string): AgentModelCard | undefined {
  return allModelCards.find((card) => card.specifier === specifier);
}

export function modelSpecifierFromParts(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}
