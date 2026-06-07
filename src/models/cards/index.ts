export { createCodexBrainCard } from './codex-brain.js';
export { deepseekV4ProCard } from './deepseek-v4-pro.js';
export { providerContextWindow } from './limits.js';
export { minimaxM3Card } from './minimax-m3.js';
export { qwen35Card } from './qwen3-5.js';

import { deepseekV4ProCard } from './deepseek-v4-pro.js';
import { minimaxM3Card } from './minimax-m3.js';
import { qwen35Card } from './qwen3-5.js';
import type { AgentModelProfile } from '../types.js';

export const ollamaCloudCards = [minimaxM3Card, deepseekV4ProCard, qwen35Card] as const;
export const allModelCards = [...ollamaCloudCards] as const;

export function resolveModelCard(specifier: string): AgentModelProfile | undefined {
  return allModelCards.find((card) => card.specifier === specifier);
}

export function modelSpecifierFromParts(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}
