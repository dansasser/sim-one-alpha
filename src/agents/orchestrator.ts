import {
  createAgent,
  defineAgentProfile,
  type AgentRouteHandler,
} from '@flue/runtime';
import { configureRuntimeModels, resolveModelCard } from '../models/index.js';
import { calculateContextBudget } from '../session/context-budget.js';
import { goromboFlueSessionStore } from '../session/flue-session-store.js';
import { loadProtocolsTool, retrieveContextTool, retrieveMemoryTool } from '../tools/index.js';
import type { AgentModelProfile } from '../models/types.js';

export const route: AgentRouteHandler = async (_c, next) => next();

const codingWorker = defineAgentProfile({
  name: 'coding_worker',
  model: false,
  instructions:
    'Placeholder coding worker profile. Do not autonomously edit code yet; future phases add plan, edit, test, debug loop, diff, and approval behavior.',
});

const instructions = `
You are the GOROMBO main orchestrator.

Load protocols before final reasoning, retrieve memory/context when useful, use registry-backed tools, and delegate only to defined workers.
Use the configured model profile from the project model registry. Do not claim protocol, memory, RAG, or search integrations are live beyond the tools that are actually wired.
The retrieve_context tool is wired to the RAG router. Web search uses Ollama Search when an Ollama API key is configured, while memory and document-index providers remain placeholders.
`;

export default createAgent(({ env }) => {
  const models = configureRuntimeModels(env);
  const defaultModelCard = resolveModelCard(models.defaultAgentModel);

  return {
    model: models.defaultAgentModel,
    instructions,
    compaction: defaultModelCard ? createFlueCompactionConfig(defaultModelCard) : undefined,
    persist: goromboFlueSessionStore,
    tools: [loadProtocolsTool, retrieveMemoryTool, retrieveContextTool],
    subagents: [codingWorker],
  };
});

export function createFlueCompactionConfig(modelCard: AgentModelProfile): {
  reserveTokens: number;
  keepRecentTokens: number;
  model: string;
} {
  const budget = calculateContextBudget(modelCard);

  return {
    reserveTokens: budget.compactionReserveTokens,
    keepRecentTokens: budget.keepRecentTokens,
    model: modelCard.specifier,
  };
}
