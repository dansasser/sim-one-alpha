import {
  createAgent,
  defineAgentProfile,
  type AgentProfile,
  type AgentRouteHandler,
} from '@flue/runtime';
import { configureRuntimeModels, resolveModelCard } from '../models/index.js';
import type { AgentModelProfile } from '../models/types.js';
import { calculateContextBudget } from '../session/context-budget.js';
import { goromboFlueSessionStore } from '../session/flue-session-store.js';
import { webResearchTool } from '../tools/index.js';

export const route: AgentRouteHandler = async (_c, next) => next();

export const researcherAgentName = 'researcher';

const researcherInstructions = `
You are the GOROMBO research subagent.

Own all web research behavior. Decide whether the request needs one search, multiple searches, page fetches, source comparison, or a direct no-search answer.
Use web_research for source-backed, current, external, or web-backed research. The tool runs the researcher-owned research workflow with cache, query planning, web search, page fetch, source packing, and confidence metadata.
Compare retrieved sources before answering. Preserve source URLs from returned source metadata when they are available.
If providerFailures reports a failed source, say which source failed and continue with the remaining context.
Return concise structured findings that the main orchestrator can use directly. Do not edit code, run shell commands, or claim access to providers that are not wired.
`;

export function createResearcherProfile(model: string): AgentProfile {
  return defineAgentProfile({
    name: researcherAgentName,
    description: 'source-backed research subagent that uses the retrieval workflow and Ollama Search.',
    model,
    instructions: researcherInstructions,
    tools: [webResearchTool],
  });
}

export default createAgent(({ env }) => {
  const models = configureRuntimeModels(env);
  const defaultModelCard = resolveModelCard(models.defaultAgentModel);

  return {
    profile: createResearcherProfile(models.defaultAgentModel),
    model: models.defaultAgentModel,
    compaction: defaultModelCard ? createResearchCompactionConfig(defaultModelCard) : undefined,
    persist: goromboFlueSessionStore,
  };
});

function createResearchCompactionConfig(modelCard: AgentModelProfile): {
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
