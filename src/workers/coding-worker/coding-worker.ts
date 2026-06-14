import {
  createAgent,
  defineAgentProfile,
  type AgentProfile,
  type AgentRouteHandler,
} from '@flue/runtime';
import { local } from '@flue/runtime/node';
import { realpath } from 'node:fs/promises';
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
import { createCodingWorkerLoopDelegate } from './workflow/loop.js';
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
  createCodingWorkerLoopCapabilityBlock(),
].join('\n\n');

export function createCodingWorkerLoopCapabilityBlock(): string {
  return `# Lead Loop Contract

The coding-worker lead runs a bounded, approval-gated, Flue-native tool-calling loop:

1. Accept a natural-language coding task scoped to the configured workspace/project/repo.
2. Run triage to classify the task and produce a plan.
3. Run the implementer subagent to produce file edits and file writes.
4. Apply edits only after an explicit file.edit approval record exists.
5. Run the test-debug subagent to verify changes; on failure, request debug edits, apply them after approval, and rerun.
6. Run the code-review subagent; if rejected, replan and return to implementation up to the configured replan budget. If rejections persist, pause with a blocked status for human review.
7. If GitHub context is present, run the github subagent to prepare commit/push/PR actions and execute them through the approval-gated git/GitHub tools.
8. Emit public progress events at every checkpoint and persist a loop checkpoint to the task-run store.

Default max turns: 10. The loop returns blocked if it exceeds the turn guard without completing. All mutating side effects (file edits, git commit, push, PR create/update) require an explicit approval record. The model cannot approve its own requests.`;
}

/**
 * Creates the reusable coding worker Flue subagent profile used by the orchestrator.
 */
export async function createCodingWorkerSubagent(options: CodingWorkerSubagentOptions = {}): Promise<AgentProfile> {
  const resolvedOptions = options;
  const workspaceRoot = resolveSubagentWorkspaceRoot(resolvedOptions);
  const approvalRoot = resolveApprovalRoot(resolvedOptions, workspaceRoot);
  if (!approvalRoot) {
    throw new Error('Missing coding-worker approval storage root configuration.');
  }
  await assertApprovalRootOutsideWorkspace(approvalRoot, workspaceRoot);
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

export default createAgent(async ({ env }) => {
  const models = configureRuntimeModels(env);
  const selectedModelCard = models.selectedModelCard;
  const workspaceRoot = resolveCodingWorkerWorkspaceRoot(env);

  return {
    profile: await createCodingWorkerSubagent({
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

async function assertApprovalRootOutsideWorkspace(approvalRoot: string, workspaceRoot: string | undefined): Promise<void> {
  if (!workspaceRoot) {
    return;
  }
  const resolvedApproval = await realpath(resolvePath(approvalRoot)).catch(() => resolvePath(approvalRoot));
  const resolvedWorkspace = await realpath(resolvePath(workspaceRoot)).catch(() => resolvePath(workspaceRoot));
  const workspacePrefix = resolvedWorkspace.endsWith(sep) ? resolvedWorkspace : resolvedWorkspace + sep;
  const isInside = pathsEqual(resolvedApproval, resolvedWorkspace) || resolvedApproval.startsWith(workspacePrefix);
  if (isInside) {
    throw new Error(
      'Approval persistence root must be outside the coding-worker workspace root to prevent model tampering. ' +
        `approvalRoot=${approvalRoot} workspaceRoot=${workspaceRoot}`,
    );
  }
}

function pathsEqual(left: string, right: string): boolean {
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
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

export { createCodingWorkerLoopDelegate } from './workflow/loop.js';

function readOptionalEnv(env: Record<string, unknown>, key: string): string | undefined {
  const value = env[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
