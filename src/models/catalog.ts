export { providerContextWindow } from './card-limits.js';
export { codexBrainCard, codexBrainCards } from './providers/codex-brain/index.js';
export {
  deepseekV4ProCard,
  kimik27codeCard,
  minimaxM3Card,
  nomicEmbedTextCloudCard,
  ollamaCloudCards,
  qwen35Card,
} from './providers/ollama-cloud/index.js';
export { nomicEmbedTextLocalCard, ollamaLocalCards } from './providers/ollama-local/index.js';

import { codexBrainCards } from './providers/codex-brain/index.js';
import { ollamaCloudCards } from './providers/ollama-cloud/index.js';
import { ollamaLocalCards } from './providers/ollama-local/index.js';
import type { AgentModelCard } from './types.js';

export const allModelCards = [...ollamaCloudCards, ...codexBrainCards, ...ollamaLocalCards] as const;

export function resolveModelCard(specifier: string): AgentModelCard | undefined {
  return allModelCards.find((card) => card.specifier === specifier);
}

export function modelSpecifierFromParts(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}
