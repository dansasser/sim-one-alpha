export { deepseekV4ProCard } from '../../../../../core/models/providers/ollama-cloud/cards/deepseek-v4-pro.js';
export { minimaxM3Card } from '../../../../../core/models/providers/ollama-cloud/cards/minimax-m3.js';
export { qwen35Card } from '../../../../../core/models/providers/ollama-cloud/cards/qwen3-5.js';
export { kimik27codeCard } from '../../../../../core/models/providers/ollama-cloud/cards/kimi-k2-7-code.js';
export { nomicEmbedTextCloudCard } from '../../../../../core/models/providers/ollama-cloud/cards/nomic-embed-text.js';

import { deepseekV4ProCard } from '../../../../../core/models/providers/ollama-cloud/cards/deepseek-v4-pro.js';
import { minimaxM3Card } from '../../../../../core/models/providers/ollama-cloud/cards/minimax-m3.js';
import { qwen35Card } from '../../../../../core/models/providers/ollama-cloud/cards/qwen3-5.js';
import { kimik27codeCard } from '../../../../../core/models/providers/ollama-cloud/cards/kimi-k2-7-code.js';
import { nomicEmbedTextCloudCard } from '../../../../../core/models/providers/ollama-cloud/cards/nomic-embed-text.js';

export const ollamaCloudCards = [minimaxM3Card, deepseekV4ProCard, qwen35Card, kimik27codeCard, nomicEmbedTextCloudCard] as const;
