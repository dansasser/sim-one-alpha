export { deepseekV4ProCard } from './deepseek-v4-pro.js';
export { minimaxM3Card } from './minimax-m3.js';
export { qwen35Card } from './qwen3-5.js';

import { deepseekV4ProCard } from './deepseek-v4-pro.js';
import { minimaxM3Card } from './minimax-m3.js';
import { qwen35Card } from './qwen3-5.js';

export const ollamaCloudCards = [minimaxM3Card, deepseekV4ProCard, qwen35Card] as const;
