import {
  createAgent,
  defineAgentProfile,
  type AgentProfile,
  type AgentRouteHandler,
} from '@flue/runtime';
import { local } from '@flue/runtime/node';
import { configureRuntimeModels } from '../../models/index.js';
import {
  composeWorkspaceInstructions,
  resolveWorkspaceDirectory,
} from '../../workspace-loader.js';
import type { WorkerRunRequest, WorkerRunResult } from '../../types/index.js';
import { createCodingGitHubTools } from './github/github-tools.js';
import { createCodingWorkerRuntimeCapabilityBlock } from './runtime-capabilities.js';
import { codingWorkerSkills, createCodingWorkerSkillCapabilityBlock } from './skills.js';
import { createCodingWorkerInternalSubagents } from './subagents/index.js';

export const codingWorkerAgentName = 'coding-worker';
export const route: AgentRouteHandler = async (_c, next) => next();

export const codingWorkerInstructions = [
  composeWorkspaceInstructions({
    workspaceDir: resolveWorkspaceDirectory('workers/coding-worker/workspace'),
    title: 'Coding Worker Workspace Instructions',
  }),
  createCodingWorkerRuntimeCapabilityBlock(),
  createCodingWorkerSkillCapabilityBlock(),
].join('\n\n');

/**
 * Creates the reusable coding worker Flue subagent profile used by the orchestrator.
 */
export function createCodingWorkerSubagent(model?: string): AgentProfile {
  return defineAgentProfile({
    name: codingWorkerAgentName,
    description:
      'coding worker lead that coordinates worker-local triage, implementation, test/debug, code review, and GitHub subagents.',
    ...(model ? { model } : {}),
    instructions: codingWorkerInstructions,
    tools: createCodingGitHubTools(),
    skills: codingWorkerSkills,
    subagents: createCodingWorkerInternalSubagents(model),
  });
}

export default createAgent(({ env }) => {
  const models = configureRuntimeModels(env);
  const selectedModelCard = models.selectedModelCard;
  const repoPath = resolveCodingWorkerRepoPath(env);

  return {
    profile: createCodingWorkerSubagent(selectedModelCard.specifier),
    model: selectedModelCard.specifier,
    cwd: repoPath,
    sandbox: local({
      cwd: repoPath,
      env: {
        GH_TOKEN: readOptionalEnv(env, 'GH_TOKEN'),
        GITHUB_TOKEN: readOptionalEnv(env, 'GITHUB_TOKEN'),
      },
    }),
  };
});

export async function runCodingWorkerPlaceholder(
  request: WorkerRunRequest,
): Promise<WorkerRunResult> {
  return {
    id: `coding-worker-result:${request.id}`,
    workerId: request.workerId,
    status: 'not_implemented',
    summary:
      'Coding worker direct placeholder helper is retained for legacy typed callers. Use the coding-worker Flue profile and worker-owned coding-task workflow for real coding work.',
    artifacts: [],
  };
}

function resolveCodingWorkerRepoPath(env: Record<string, unknown>): string {
  return readOptionalEnv(env, 'GOROMBO_CODING_REPO_PATH') ?? process.cwd();
}

function readOptionalEnv(env: Record<string, unknown>, key: string): string | undefined {
  const value = env[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
