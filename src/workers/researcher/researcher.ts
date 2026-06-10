import {
  createAgent,
  defineAgentProfile,
  type AgentProfile,
  type AgentRouteHandler,
} from '@flue/runtime';
import { configureRuntimeModels } from '../../models/index.js';
import type { AgentModelCard } from '../../models/types.js';
import {
  composeWorkspaceInstructions,
  resolveWorkspaceDirectory,
} from '../../persona/workspace-loader.js';
import { calculateContextBudget } from '../../session/context-budget.js';
import { goromboFlueSessionStore } from '../../session/flue-session-store.js';
import { webResearchTool } from '../../tools/index.js';

export const route: AgentRouteHandler = async (_c, next) => next();

export const researcherAgentName = 'researcher';

export const researcherInstructions = [
  composeWorkspaceInstructions({
    workspaceDir: resolveWorkspaceDirectory('workers/researcher/workspace'),
    title: 'Researcher Workspace Instructions',
  }),
  createResearcherRuntimeCapabilityBlock(),
].join('\n\n');

export function createResearcherSubagent(model?: string): AgentProfile {
  return defineAgentProfile({
    name: researcherAgentName,
    description: 'source-backed research subagent that uses the retrieval workflow and Ollama Search.',
    ...(model ? { model } : {}),
    instructions: researcherInstructions,
    tools: [webResearchTool],
  });
}

export default createAgent(({ env }) => {
  const models = configureRuntimeModels(env);
  const selectedModelCard = models.selectedModelCard;

  return {
    profile: createResearcherSubagent(selectedModelCard.specifier),
    model: selectedModelCard.specifier,
    compaction: createResearchCompactionConfig(selectedModelCard),
    persist: goromboFlueSessionStore,
  };
});

function createResearchCompactionConfig(modelCard: AgentModelCard): {
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

function createResearcherRuntimeCapabilityBlock(): string {
  return `# Runtime Capabilities

The following capabilities are actually attached to this researcher profile at runtime:

- Tool: \`web_research\`

Use only attached tools and provider capabilities. If a workspace file mentions a future capability that is not attached at runtime, report that limitation instead of pretending it exists.`;
}
