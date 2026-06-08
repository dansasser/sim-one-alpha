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
import { retrieveContextTool } from '../tools/index.js';

export const route: AgentRouteHandler = async (_c, next) => next();

export const researcherAgentName = 'researcher';

const researcherInstructions = `
You are the GOROMBO research subagent.

Use retrieve_context for source-backed research. Prefer webFetch auto for normal research and webFetch always when snippets are not enough.
Compare retrieved sources before answering. Preserve source URLs from retrieved context metadata when they are available.
If metadata.providerFailures reports a failed source, say which source failed and continue with the remaining context.
Return concise findings that the main orchestrator can use directly. Do not edit code, run shell commands, or claim access to providers that are not wired.
`;

export function createResearcherProfile(model: string): AgentProfile {
  return defineAgentProfile({
    name: researcherAgentName,
    description: 'source-backed research subagent that uses the retrieval workflow and Ollama Search.',
    model,
    instructions: researcherInstructions,
    tools: [retrieveContextTool],
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
