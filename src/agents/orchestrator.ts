import {
  createAgent,
  defineAgentProfile,
  type AgentRouteHandler,
} from '@flue/runtime';
import { configureRuntimeModels } from '../models/index.js';
import { calculateContextBudget } from '../session/context-budget.js';
import { goromboFlueSessionStore } from '../session/flue-session-store.js';
import { loadProtocolsTool, retrieveMemoryTool } from '../tools/index.js';
import type { AgentModelCard } from '../models/types.js';
import { createResearcherSubagent } from './researcher.js';

export const route: AgentRouteHandler = async (_c, next) => next();

const codingWorker = defineAgentProfile({
  name: 'coding_worker',
  model: false,
  instructions:
    'Placeholder coding worker subagent. Do not autonomously edit code yet; future phases add plan, edit, test, debug loop, diff, and approval behavior.',
});

const instructions = `
You are the GOROMBO main orchestrator.

Load protocols before final reasoning, retrieve memory when useful, use registry-backed tools, and delegate only to defined workers.
Use the configured model card from the project model registry. Do not claim protocol, memory, RAG, or search integrations are live beyond the tools that are actually wired.
You do not perform web search directly and you do not call web-capable retrieval tools.
For any current, external, web, source-backed, or research task, delegate with the Flue task tool using agent: "researcher".
Simple internal memory lookup may use retrieve_memory. Web search uses Ollama Search only inside the researcher-owned research workflow.
Pass the researcher's findings into your final answer and mention provider failures when they affect confidence.
`;

export default createAgent(({ env }) => {
  const models = configureRuntimeModels(env);
  const selectedModelCard = models.selectedModelCard;
  const researcher = createResearcherSubagent();

  return {
    model: selectedModelCard.specifier,
    instructions,
    compaction: createFlueCompactionConfig(selectedModelCard),
    persist: goromboFlueSessionStore,
    tools: [loadProtocolsTool, retrieveMemoryTool],
    subagents: [codingWorker, researcher],
  };
});

export function createFlueCompactionConfig(modelCard: AgentModelCard): {
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
