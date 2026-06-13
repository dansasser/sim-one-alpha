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
import { createCodingGitHubTools } from './github/github-tools.js';
import { createCodingWorkerRuntimeCapabilityBlock } from './runtime-capabilities.js';
import { codingWorkerSkills, createCodingWorkerSkillCapabilityBlock } from './skills.js';
import { createCodingWorkerInternalSubagents } from './subagents/index.js';
import { createCodingGitTools } from './tools/coding-git-tools.js';
import { createCodingRepoTools } from './tools/coding-repo-tools.js';
import type { CodingWorkspaceTargetInput } from './repo/workspace-target.js';

export const codingWorkerAgentName = 'coding-worker';
export const route: AgentRouteHandler = async (_c, next) => next();

export interface CodingWorkerSubagentOptions extends CodingWorkspaceTargetInput {
  model?: string;
  env?: Record<string, string | undefined>;
  allowLocalDevFallback?: boolean;
}

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
export function createCodingWorkerSubagent(options: string | CodingWorkerSubagentOptions = {}): AgentProfile {
  const resolvedOptions = typeof options === 'string' ? { model: options } : options;
  const workspaceRoot = resolveSubagentWorkspaceRoot(resolvedOptions);

  return defineAgentProfile({
    name: codingWorkerAgentName,
    description:
      'coding worker lead that coordinates worker-local triage, implementation, test/debug, code review, and GitHub subagents.',
    ...(resolvedOptions.model ? { model: resolvedOptions.model } : {}),
    instructions: codingWorkerInstructions,
    tools: [
      ...createCodingRepoTools({
        workspaceRoot,
        targetKind: resolvedOptions.targetKind,
        projectId: resolvedOptions.projectId,
        projectSlug: resolvedOptions.projectSlug,
        projectRelativePath: resolvedOptions.projectRelativePath,
        repoPath: resolvedOptions.repoPath,
        env: resolvedOptions.env,
        sessionId: 'coding-worker-profile-tools',
      }),
      ...createCodingGitTools({
        workspaceRoot,
        targetKind: resolvedOptions.targetKind,
        projectId: resolvedOptions.projectId,
        projectSlug: resolvedOptions.projectSlug,
        projectRelativePath: resolvedOptions.projectRelativePath,
        repoPath: resolvedOptions.repoPath,
        env: resolvedOptions.env,
        sessionId: 'coding-worker-git-tools',
      }),
      ...createCodingGitHubTools(),
    ],
    skills: codingWorkerSkills,
    subagents: createCodingWorkerInternalSubagents(resolvedOptions.model),
  });
}

export default createAgent(({ env }) => {
  const models = configureRuntimeModels(env);
  const selectedModelCard = models.selectedModelCard;
  const workspaceRoot = resolveCodingWorkerWorkspaceRoot(env);

  return {
    profile: createCodingWorkerSubagent({
      model: selectedModelCard.specifier,
      workspaceRoot,
      env: createCodingWorkerToolEnv(env),
    }),
    model: selectedModelCard.specifier,
    cwd: workspaceRoot,
    sandbox: local({
      cwd: workspaceRoot,
      env: {
        GH_TOKEN: readOptionalEnv(env, 'GH_TOKEN'),
        GITHUB_TOKEN: readOptionalEnv(env, 'GITHUB_TOKEN'),
      },
    }),
  };
});

function resolveCodingWorkerWorkspaceRoot(env: Record<string, unknown>): string {
  const configuredRoot =
    readOptionalEnv(env, 'GOROMBO_WORKSPACE_ROOT') ??
    readOptionalEnv(env, 'GOROMBO_CODING_WORKSPACE_ROOT') ??
    readOptionalEnv(env, 'GOROMBO_CODING_REPO_PATH');
  if (configuredRoot) {
    return configuredRoot;
  }
  if (readOptionalEnv(env, 'GOROMBO_ALLOW_CWD_WORKSPACE_FALLBACK') === 'true') {
    return process.cwd();
  }
  throw new Error(
    'Missing coding-worker workspace root configuration. Set GOROMBO_WORKSPACE_ROOT or GOROMBO_CODING_WORKSPACE_ROOT.',
  );
}

function resolveSubagentWorkspaceRoot(options: CodingWorkerSubagentOptions): string | undefined {
  if (options.workspaceRoot || options.repoPath) {
    return options.workspaceRoot;
  }
  if (options.allowLocalDevFallback) {
    return process.cwd();
  }
  throw new Error('Missing coding-worker workspace root configuration.');
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
