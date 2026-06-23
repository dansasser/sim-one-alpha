import { resolve } from 'node:path';
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
import {
  addKnowledgeTool,
  loadProtocolsTool,
  retrieveMemoryTool,
  generateImageTool,
  recordImageArtifactTool,
  listImageArtifactsTool,
  createChecklistTool,
  updateChecklistTool,
  addChecklistItemTool,
  updateChecklistItemTool,
  moveChecklistItemTool,
  archiveChecklistTool,
  listChecklistsTool,
  createTodoTool,
  completeTodoTool,
  updateTodoTool,
  cancelTodoTool,
  listTodosTool,
  storeSessionNoteTool,
  updateSessionNoteTool,
  archiveSessionNoteTool,
  listSessionNotesTool,
  searchMemoryRecordsTool,
  scheduleCreateTool,
  schedulePauseTool,
  scheduleResumeTool,
  scheduleUpdateTool,
  scheduleDeleteTool,
  scheduleListTool,
  scheduleGetTool,
  scheduleRunNowTool,
  scheduleRunsTool,
} from '../tools/index.js';
import type { AgentModelCard } from '../models/types.js';
import { telegramReplyTool } from '../channels/telegram.js';
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

export default createAgent(async ({ env }) => {
  const models = configureRuntimeModels(env);
  const selectedModelCard = models.selectedModelCard;
  const codingWorker = await createCodingWorkerSubagent({
    workspaceRoot: resolveCodingWorkerWorkspaceRoot(env),
    env: createCodingWorkerToolEnv(env),
  });
  const researcher = createResearcherSubagent();

  return {
    model: selectedModelCard.specifier,
    instructions: orchestratorInstructions,
    compaction: createFlueCompactionConfig(selectedModelCard),
    tools: [
      loadProtocolsTool,
      retrieveMemoryTool,
      addKnowledgeTool,
      createChecklistTool,
      updateChecklistTool,
      addChecklistItemTool,
      updateChecklistItemTool,
      moveChecklistItemTool,
      archiveChecklistTool,
      listChecklistsTool,
      createTodoTool,
      completeTodoTool,
      updateTodoTool,
      cancelTodoTool,
      listTodosTool,
      storeSessionNoteTool,
      updateSessionNoteTool,
      archiveSessionNoteTool,
      listSessionNotesTool,
      searchMemoryRecordsTool,
      generateImageTool,
      recordImageArtifactTool,
      listImageArtifactsTool,
      scheduleCreateTool,
      schedulePauseTool,
      scheduleResumeTool,
      scheduleUpdateTool,
      scheduleDeleteTool,
      scheduleListTool,
      scheduleGetTool,
      scheduleRunNowTool,
      scheduleRunsTool,
      telegramReplyTool,
    ],
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

export function resolveCodingWorkerWorkspaceRoot(env: Record<string, unknown>): string {
  const configuredRoot =
    readOptionalEnv(env, 'GOROMBO_WORKSPACE_ROOT') ??
    readOptionalEnv(env, 'GOROMBO_CODING_WORKSPACE_ROOT') ??
    readOptionalEnv(env, 'GOROMBO_CODING_REPO_PATH');

  if (configuredRoot) {
    return configuredRoot;
  }

  return resolve('src/workspace');
}

function createCodingWorkerToolEnv(env: Record<string, unknown>): Record<string, string | undefined> {
  return {
    GH_TOKEN: readOptionalEnv(env, 'GH_TOKEN'),
    GITHUB_TOKEN: readOptionalEnv(env, 'GITHUB_TOKEN'),
  };
}

function readOptionalEnv(env: Record<string, unknown>, key: string): string | undefined {
  const value = env[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Describes the orchestrator capabilities that are actually wired at runtime.
 */
function createOrchestratorRuntimeCapabilityBlock(): string {
  return `# Runtime Capabilities

The following capabilities are actually attached to this main agent at runtime:

- Tool: \`load_protocols\`
- Tool: \`retrieve_memory\`
- Tool: \`add_knowledge\`
- Tool: \`create_checklist\` / \`update_checklist\` / \`archive_checklist\` / \`list_checklists\`
- Tool: \`add_checklist_item\` / \`update_checklist_item\` / \`move_checklist_item\`
- Tool: \`create_todo\` / \`update_todo\` / \`complete_todo\` / \`cancel_todo\` / \`list_todos\`
- Tool: \`store_session_note\` / \`update_session_note\` / \`archive_session_note\` / \`list_session_notes\`
- Tool: \`search_memory_records\`
- Tool: \`generate_image\`
- Tool: \`record_image_artifact\`
- Tool: \`list_image_artifacts\`
- Tool: \`telegram_reply\` (when TELEGRAM_BOT_TOKEN is configured)
- Subagent: \`researcher\`
- Subagent: \`coding-worker\`

Use the configured model card from the project model registry. Do not claim protocol, memory, RAG, search, email, calendar, repository, or other integrations are live beyond the tools and subagents that are actually wired.

For any current, external, web, source-backed, or research task, delegate with the Flue task tool using agent: "researcher". Do not perform web search directly and do not call web-capable retrieval tools from the main agent. The researcher owns \`web_research\`, including basic, standard, and deep research modes.

For coding-related work, delegate with the Flue task tool using agent: "coding-worker". Do not call coding-worker internal subagents directly. The coding-worker lead decides whether triage, implementer, test-debug, code-review, GitHub/PR, or future worker-local subagents are needed. Surface coding-worker public progress events and structured results to the user when available.

Use \`load_protocols\` before final reasoning. The result is a JSON string containing a \`ProtocolBundle\`. Parse it and include the parsed object as \`protocolBundle\` in the task input when delegating to \`coding-worker\`. The coding-worker lead will apply directives from \`protocolBundle.protocols[].rules\` to its loop.

Use \`retrieve_memory\` when stored conversation, project, or user context would materially help. Pass delegated findings into the final answer, and mention \`providerFailures\` when they affect confidence.`;
}
