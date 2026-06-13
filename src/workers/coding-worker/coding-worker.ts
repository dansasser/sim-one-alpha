import {
  createAgent,
  defineAgentProfile,
  type AgentProfile,
  type AgentRouteHandler,
} from '@flue/runtime';
import { local } from '@flue/runtime/node';
import { resolve as resolvePath, sep } from 'node:path';
import { configureRuntimeModels } from '../../models/index.js';
import {
  composeWorkspaceInstructions,
  resolveWorkspaceDirectory,
} from '../../workspace-loader.js';
import { createFileCodingApprovalService } from './approvals/approval-service.js';
import { createDefaultGitHubClient } from './github/gh-cli-client.js';
import { createCodingGitHubTools } from './github/github-tools.js';
import type { GitHubClient } from './github/github-client.js';
import { createCodingWorkerRuntimeCapabilityBlock } from './runtime-capabilities.js';
import { codingWorkerSkills, createCodingWorkerSkillCapabilityBlock } from './skills.js';
import { createCodingWorkerInternalSubagents } from './subagents/index.js';
import { createCodingGitTools } from './tools/coding-git-tools.js';
import { createCodingRepoTools } from './tools/coding-repo-tools.js';
import { createCodingRepoWorkflowTools } from './tools/coding-repo-workflow-tools.js';
import type { CodingWorkspaceTargetInput } from './repo/workspace-target.js';

export const codingWorkerAgentName = 'coding-worker';
export const route: AgentRouteHandler = async (_c, next) => next();

export interface CodingWorkerSubagentOptions extends CodingWorkspaceTargetInput {
  model?: string;
  env?: Record<string, string | undefined>;
  allowLocalDevFallback?: boolean;
  githubClient?: GitHubClient;
  /**
   * Root directory for approval persistence. Must be outside workspaceRoot.
   * Falls back to a sibling of workspaceRoot when omitted.
   */
  approvalRoot?: string;
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
export function createCodingWorkerSubagent(options: CodingWorkerSubagentOptions = {}): AgentProfile {
  const resolvedOptions = options;
  const workspaceRoot = resolveSubagentWorkspaceRoot(resolvedOptions);
  const approvalRoot = resolveApprovalRoot(resolvedOptions, workspaceRoot);
  if (!approvalRoot) {
    throw new Error('Missing coding-worker approval storage root configuration.');
  }
  assertApprovalRootOutsideWorkspace(approvalRoot, workspaceRoot);
  const approvalService = createFileCodingApprovalService(approvalRoot);
  const githubClient = resolvedOptions.githubClient ?? createDefaultGitHubClient(resolvedOptions.env);

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
        approvalService,
      }),
      ...createCodingRepoWorkflowTools({
        workspaceRoot,
        targetKind: resolvedOptions.targetKind,
        projectId: resolvedOptions.projectId,
        projectSlug: resolvedOptions.projectSlug,
        projectRelativePath: resolvedOptions.projectRelativePath,
        repoPath: resolvedOptions.repoPath,
        env: resolvedOptions.env,
        sessionId: 'coding-worker-repo-workflow-tools',
        approvalService,
      }),
      ...createCodingGitHubTools({
        client: githubClient,
        approvalService,
      }),
    ],
    skills: codingWorkerSkills,
    subagents: createCodingWorkerInternalSubagents({
      model: resolvedOptions.model,
      workspaceRoot,
      targetKind: resolvedOptions.targetKind,
      projectId: resolvedOptions.projectId,
      projectSlug: resolvedOptions.projectSlug,
      projectRelativePath: resolvedOptions.projectRelativePath,
      repoPath: resolvedOptions.repoPath,
      env: resolvedOptions.env,
      approvalService,
      githubClient,
    }),
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
      approvalRoot: readOptionalEnv(env, 'GOROMBO_APPROVAL_ROOT'),
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

function resolveApprovalRoot(
  options: CodingWorkerSubagentOptions,
  workspaceRoot: string | undefined,
): string | undefined {
  if (options.approvalRoot) {
    return resolvePath(options.approvalRoot);
  }
  if (workspaceRoot) {
    return resolvePath(workspaceRoot, '..', '.gorombo-approvals');
  }
  return options.repoPath ? resolvePath(options.repoPath, '..', '.gorombo-approvals') : undefined;
}

function assertApprovalRootOutsideWorkspace(approvalRoot: string, workspaceRoot: string | undefined): void {
  if (!workspaceRoot) {
    return;
  }
  const normalizedApproval = resolvePath(approvalRoot).toLowerCase();
  const normalizedWorkspace = resolvePath(workspaceRoot).toLowerCase();
  const workspacePrefix = normalizedWorkspace.endsWith(sep) ? normalizedWorkspace : normalizedWorkspace + sep;
  if (normalizedApproval === workspacePrefix.slice(0, -1) || normalizedApproval.startsWith(workspacePrefix)) {
    throw new Error(
      'Approval persistence root must be outside the coding-worker workspace root to prevent model tampering. ' +
        `approvalRoot=${approvalRoot} workspaceRoot=${workspaceRoot}`,
    );
  }
}

function resolveSubagentWorkspaceRoot(options: CodingWorkerSubagentOptions): string {
  if (options.workspaceRoot || options.repoPath) {
    return options.workspaceRoot ?? options.repoPath!;
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
