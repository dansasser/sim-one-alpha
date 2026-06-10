import {
  createAgent,
  type AgentRouteHandler,
} from '@flue/runtime';
import { configureRuntimeModels } from '../models/index.js';
import {
  composeWorkspaceInstructions,
  resolveWorkspaceDirectory,
} from '../workspace-loader.js';
import { calculateContextBudget } from '../session/context-budget.js';
import { goromboFlueSessionStore } from '../session/flue-session-store.js';
import { loadProtocolsTool, retrieveMemoryTool } from '../tools/index.js';
import type { AgentModelCard } from '../models/types.js';
import { createCodingWorkerSubagent } from '../workers/coding-worker/coding-worker.js';
import { createResearcherSubagent } from '../workers/researcher/researcher.js';

export const route: AgentRouteHandler = async (_c, next) => next();

export const orchestratorInstructions = [
  composeWorkspaceInstructions({
    workspaceDir: resolveWorkspaceDirectory('workspace'),
    title: 'Main Agent Workspace Instructions',
  }),
  createOrchestratorRuntimeCapabilityBlock(),
].join('\n\n');

export default createAgent(({ env }) => {
  const models = configureRuntimeModels(env);
  const selectedModelCard = models.selectedModelCard;
  const codingWorker = createCodingWorkerSubagent();
  const researcher = createResearcherSubagent();

  return {
    model: selectedModelCard.specifier,
    instructions: orchestratorInstructions,
    compaction: createFlueCompactionConfig(selectedModelCard),
    persist: goromboFlueSessionStore,
    tools: [loadProtocolsTool, retrieveMemoryTool],
    subagents: [codingWorker, researcher],
  };
});

/**
 * Creates the orchestrator compaction policy from the selected model card budget.
 */
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

/**
 * Describes the orchestrator capabilities that are actually wired at runtime.
 */
function createOrchestratorRuntimeCapabilityBlock(): string {
  return `# Runtime Capabilities

The following capabilities are actually attached to this main agent at runtime:

- Tool: \`load_protocols\`
- Tool: \`retrieve_memory\`
- Subagent: \`researcher\`
- Subagent: \`coding-worker\` placeholder

Use the configured model card from the project model registry. Do not claim protocol, memory, RAG, search, email, calendar, repository, or other integrations are live beyond the tools and subagents that are actually wired.

For any current, external, web, source-backed, or research task, delegate with the Flue task tool using agent: "researcher". Do not perform web search directly and do not call web-capable retrieval tools from the main agent. The researcher owns \`web_research\`, including basic, standard, and deep research modes.

Use \`load_protocols\` before final reasoning. Use \`retrieve_memory\` when stored conversation, project, or user context would materially help. Pass delegated findings into the final answer, and mention \`providerFailures\` when they affect confidence.`;
}
