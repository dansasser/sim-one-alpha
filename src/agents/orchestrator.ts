import { resolve } from 'node:path';
import {
  createAgent,
  type AgentRouteHandler,
} from '@flue/runtime';
import { configureRuntimeModels } from '../core/models/index.js';
import {
  composeWorkspaceInstructions,
  resolveWorkspaceDirectory,
} from '../workspace-loader.js';
import { calculateContextBudget } from '../engine/session/context-budget.js';
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
  capabilityTools,
} from '../engine/tools/index.js';
import type { AgentModelCard } from '../core/models/types.js';
import { telegramReplyTool } from '../channels/telegram.js';
import { createCodingWorkerSubagent } from '../engine/workers/coding-worker/coding-worker.js';
import { createResearcherSubagent } from '../engine/workers/researcher/researcher.js';
import { createCapabilityStore } from '../engine/capabilities/capability-store.js';
import { loadUserCapabilities } from '../engine/capabilities/capability-loader.js';
import { materializeCapability } from '../engine/capabilities/skill-materializer.js';
import { connectUserMcpServers } from '../engine/capabilities/mcp-broker.js';
import { connectBuiltinMcpServers } from '../engine/capabilities/builtin-mcp.js';
import { loadUserTools } from '../engine/capabilities/tool-loader.js';
import { loadUserWorkers } from '../engine/capabilities/worker-loader.js';

export const route: AgentRouteHandler = async (_c, next) => next();

export const orchestratorInstructions = [
  composeWorkspaceInstructions({
    workspaceDir: resolveWorkspaceDirectory('workspace'),
    title: 'Main Agent Workspace Instructions',
  }),
  createOrchestratorRuntimeCapabilityBlock(),
].join('\n\n');

export default createAgent(async ({ id, env }) => {
  const models = configureRuntimeModels(env);
  const selectedModelCard = models.selectedModelCard;
  const codingWorker = await createCodingWorkerSubagent({
    workspaceRoot: resolveCodingWorkerWorkspaceRoot(env),
    env: createCodingWorkerToolEnv(env),
    trustedAgentInstanceId: id,
  });
  const researcher = createResearcherSubagent();

  const builtInTools = [
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
    ...capabilityTools,
  ];
  const builtInSubagents = [codingWorker, researcher];

  const userCapabilities = loadUserCapabilitiesFromStore(env);
  const [builtinMcpResult, mcpResult, toolResult, workerResult] = await Promise.all([
    connectBuiltinMcpServers(),
    connectUserMcpServers(userCapabilities.mcp, env),
    loadUserTools(userCapabilities.tools, env),
    loadUserWorkers(userCapabilities.workers, env),
  ]);
  const userTools = [...builtinMcpResult.tools, ...mcpResult.tools, ...toolResult.tools];
  const userSubagents: typeof builtInSubagents = [...workerResult.profiles];

  return {
    model: selectedModelCard.specifier,
    instructions: orchestratorInstructions,
    compaction: createFlueCompactionConfig(selectedModelCard),
    tools: [...builtInTools, ...userTools],
    subagents: [...builtInSubagents, ...userSubagents],
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
    GOROMBO_GITHUB_AUTH_ROOT: readOptionalEnv(env, 'GOROMBO_GITHUB_AUTH_ROOT'),
  };
}

function readOptionalEnv(env: Record<string, unknown>, key: string): string | undefined {
  const value = env[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function loadUserCapabilitiesFromStore(env: Record<string, unknown>) {
  let store;
  try {
    store = createCapabilityStore({});
    const caps = loadUserCapabilities({ store });
    for (const capability of [...caps.skills, ...caps.tools, ...caps.workers]) {
      try {
        materializeCapability({ record: capability, env });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[capabilities] Failed to materialize ${capability.kind} ${capability.id}: ${message}`);
      }
    }
    return caps;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[capabilities] Failed to load user capabilities: ${message}`);
    return { skills: [], tools: [], workers: [], mcp: [] };
  } finally {
    store?.close();
  }
}

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
- Tool: \`schedule_create\` / \`schedule_pause\` / \`schedule_resume\` / \`schedule_update\` / \`schedule_delete\` / \`schedule_list\` / \`schedule_get\` / \`schedule_run_now\` / \`schedule_runs\` (scheduled/recurring/one-shot agent turns; ownerScope is derived from the trusted eventId and enforced on every non-create op)
- Tool: \`telegram_reply\` (when TELEGRAM_BOT_TOKEN is configured)
- Tool: \`add_skill\` / \`add_tool\` / \`add_worker\` / \`add_mcp_server\` / \`list_capabilities\` (user-defined capability management; skills auto-enable, tools/workers/MCP require user approval via CLI or TUI)
- MCP: \`astro-docs\` (built-in — search Astro framework documentation via \`mcp__astro-docs__search_astro_docs\`)
- Subagent: \`researcher\`
- Subagent: \`coding-worker\` (repository inspection/editing, shell/test/debug, code review, repository lifecycle, approval-gated git operations, and GitHub work)

Use the configured model card from the project model registry. Worker-backed capabilities count as capabilities of this main agent. An attached capability does not establish that a specific provider account is authenticated, a repository is authorized, or an operation completed; require responsible worker/tool evidence.

For any current, external, web, source-backed, or research task, delegate with the Flue task tool using agent: "researcher". Do not perform web search directly and do not call web-capable retrieval tools from the main agent. The researcher owns \`web_research\`, including basic, standard, and deep research modes.

For coding-related work, including repository work and GitHub work through the Coding Worker, delegate with the Flue task tool using agent: "coding-worker". Include the trusted current eventId in the delegated request when GitHub authentication might be needed, so the worker can resolve the initiating connector/actor/conversation from persisted ingress state. Do not call coding-worker internal subagents directly. The coding-worker lead decides whether triage, implementer, test-debug, code-review, GitHub/PR, or future worker-local subagents are needed. Surface coding-worker public progress events and structured results to the user when available.

Do not use an eventId from a prior or unrelated message for GitHub authentication. Pass only the trusted current eventId supplied by the active ingress turn.

When continuing a GitHub login approved after an earlier turn, delegate the prior approvalRequestId together with the new trusted current eventId. The Coding Worker validates that continuation against the original connector, actor, and conversation.

Use \`load_protocols\` before final reasoning. The result is a JSON string containing a \`ProtocolBundle\`. Parse it and include the parsed object as \`protocolBundle\` in the task input when delegating to \`coding-worker\`. The coding-worker lead will apply directives from \`protocolBundle.protocols[].rules\` to its loop.

Use \`retrieve_memory\` when stored conversation, project, or user context would materially help. Pass delegated findings into the final answer, and mention \`providerFailures\` when they affect confidence.`;
}
