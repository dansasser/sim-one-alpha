export { deepseekV4ProCard } from './deepseek-v4-pro.js';
export { minimaxM3Card } from './minimax-m3.js';
export { qwen35Card } from './qwen3-5.js';
export { kimik27codeCard } from './kimi-k2-7-code.js';
export { nomicEmbedTextCloudCard } from './nomic-embed-text.js';

import { deepseekV4ProCard } from './deepseek-v4-pro.js';
import { minimaxM3Card } from './minimax-m3.js';
import { qwen35Card } from './qwen3-5.js';
import { kimik27codeCard } from './kimi-k2-7-code.js';
import { nomicEmbedTextCloudCard } from './nomic-embed-text.js';

export const ollamaCloudCards = [minimaxM3Card, deepseekV4ProCard, qwen35Card, kimik27codeCard, nomicEmbedTextCloudCard] as const;
