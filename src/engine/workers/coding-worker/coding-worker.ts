import {
  createAgent,
  defineAgentProfile,
  type AgentProfile,
  type AgentRouteHandler,
} from '@flue/runtime';
import { local } from '@flue/runtime/node';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve as resolvePath, sep } from 'node:path';
import { configureRuntimeModels } from '../../../core/models/index.js';
import {
  composeWorkspaceInstructions,
  resolveWorkspaceDirectory,
} from '../../../workspace-loader.js';
import { createDefaultGitHubClient } from '../../../engine/workers/coding-worker/github/gh-cli-client.js';
import { getGithubAuthService } from '../../../engine/workers/coding-worker/github/github-auth-runtime.js';
import type { GithubAuthService } from '../../../engine/workers/coding-worker/github/github-auth-service.js';
import { createCodingGithubAuthTools } from '../../../engine/workers/coding-worker/github/github-auth-tools.js';
import { githubRawTokenEnvironmentKeys } from '../../../engine/workers/coding-worker/github/github-auth-types.js';
import { createCodingGitHubTools } from '../../../engine/workers/coding-worker/github/github-tools.js';
import type { GitHubClient } from '../../../engine/workers/coding-worker/github/github-client.js';
import { createCodingWorkerRuntimeCapabilityBlock } from '../../../engine/workers/coding-worker/runtime-capabilities.js';
import { codingWorkerSkills, createCodingWorkerSkillCapabilityBlock } from '../../../engine/workers/coding-worker/skills.js';
import { createSharedCodingApprovalService } from '../../../engine/approvals/shared-approval-service.js';
import { createCodingWorkerInternalSubagents } from '../../../engine/workers/coding-worker/subagents/index.js';
import { createCodingCodeIntelligenceTools } from '../../../engine/workers/coding-worker/tools/code-intelligence/index.js';
import { createCodingGitTools } from '../../../engine/workers/coding-worker/tools/coding-git-tools.js';
import { createCodingPlanningTools } from '../../../engine/workers/coding-worker/tools/coding-planning-tools.js';
import { createCodingTaskMemoryTools } from '../../../engine/workers/coding-worker/tools/coding-task-memory-tools.js';
import { createCodingScheduleTools } from '../../../engine/workers/coding-worker/tools/coding-schedule-tools.js';
import { getStructuredMemoryEngine } from '../../../engine/memory/structured-memory-runtime.js';
import { createCodingRepoTools } from '../../../engine/workers/coding-worker/tools/coding-repo-tools.js';
import { createCodingRepoWorkflowTools } from '../../../engine/workers/coding-worker/tools/coding-repo-workflow-tools.js';
import { createCodingWorkerLoopDelegate } from '../../../engine/workers/coding-worker/workflow/loop.js';
import type { CodingWorkspaceTargetInput } from '../../../engine/workers/coding-worker/repo/workspace-target.js';

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
  /** Root for product-owned managed GitHub credentials. Must be outside workspaceRoot. */
  githubAuthRoot?: string;
  /** Injectable managed auth service for tests or an application-owned runtime. */
  githubAuthService?: GithubAuthService;
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
5. Run the test-debug subagent to verify changes; on failure, request debug edits, apply them after approval, and rerun. If verification still fails, use the coding_plan_replan tool to update the plan with the failure context.
6. Run the code-review subagent; if rejected, use the coding_plan_replan tool to surface the findings and return to implementation, up to the configured replan budget. If rejections persist, pause with a blocked status for human review.
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
  const approvalService = createSharedCodingApprovalService({ GOROMBO_APPROVAL_ROOT: approvalRoot });
  const getAuthService = () => resolvedOptions.githubAuthService
    ? Promise.resolve(resolvedOptions.githubAuthService)
    : getGithubAuthService({
        workspaceRoot,
        authRoot: resolvedOptions.githubAuthRoot ?? readOptionalEnv(resolvedOptions.env ?? {}, 'GOROMBO_GITHUB_AUTH_ROOT'),
        env: resolvedOptions.env,
      });
  const requireAuthenticatedService = async () => {
    const service = await getAuthService();
    const status = await service.status();
    if (status.state !== 'authenticated') {
      throw new Error(`Managed GitHub authentication is not usable: ${status.failureCode ?? status.state}`);
    }
    return service;
  };
  let defaultGithubClient: GitHubClient | undefined;
  const githubClient = resolvedOptions.githubClient ?? createLazyGithubClient(async () => {
    const service = await requireAuthenticatedService();
    defaultGithubClient ??= createDefaultGitHubClient(
      await service.createGhEnv(),
      resolvedOptions.repoPath ?? resolvedOptions.workspaceRoot,
    );
    return defaultGithubClient;
  });
  const githubGitEnv = async () => definedEnv(
    await (await requireAuthenticatedService()).createGitCredentialEnv(),
  );
  const executionEnv = withoutGithubCredentials(resolvedOptions.env);

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
        env: executionEnv,
        sessionId: 'coding-worker-profile-tools',
      }),
      ...createCodingCodeIntelligenceTools({
        workspaceRoot,
        targetKind: resolvedOptions.targetKind,
        projectId: resolvedOptions.projectId,
        projectSlug: resolvedOptions.projectSlug,
        projectRelativePath: resolvedOptions.projectRelativePath,
        repoPath: resolvedOptions.repoPath,
        env: executionEnv,
        sessionId: 'coding-worker-code-intelligence-tools',
      }),
      ...createCodingGitTools({
        workspaceRoot,
        targetKind: resolvedOptions.targetKind,
        projectId: resolvedOptions.projectId,
        projectSlug: resolvedOptions.projectSlug,
        projectRelativePath: resolvedOptions.projectRelativePath,
        repoPath: resolvedOptions.repoPath,
        env: executionEnv,
        sessionId: 'coding-worker-git-tools',
        approvalService,
        githubGitEnv,
      }),
      ...createCodingRepoWorkflowTools({
        workspaceRoot,
        targetKind: resolvedOptions.targetKind,
        projectId: resolvedOptions.projectId,
        projectSlug: resolvedOptions.projectSlug,
        projectRelativePath: resolvedOptions.projectRelativePath,
        repoPath: resolvedOptions.repoPath,
        env: executionEnv,
        sessionId: 'coding-worker-repo-workflow-tools',
        approvalService,
        githubGitEnv,
      }),
      ...createCodingGitHubTools({
        workspaceRoot,
        targetKind: resolvedOptions.targetKind,
        projectId: resolvedOptions.projectId,
        projectSlug: resolvedOptions.projectSlug,
        projectRelativePath: resolvedOptions.projectRelativePath,
        repoPath: resolvedOptions.repoPath,
        client: githubClient,
        approvalService,
      }),
      ...createCodingGithubAuthTools({
        workspaceRoot,
        authRoot: resolvedOptions.githubAuthRoot ?? readOptionalEnv(resolvedOptions.env ?? {}, 'GOROMBO_GITHUB_AUTH_ROOT'),
        env: resolvedOptions.env,
        approvalService,
        authServiceLoader: getAuthService,
      }),
      ...createCodingPlanningTools(),
      ...createCodingTaskMemoryTools({
        engineLoader: () => getStructuredMemoryEngine(),
        projectId: resolvedOptions.projectId,
        projectSlug: resolvedOptions.projectSlug,
        projectRelativePath: resolvedOptions.projectRelativePath,
        repoPath: resolvedOptions.repoPath,
        workspaceRoot,
        approvalService,
      }),
      ...createCodingScheduleTools({
        projectId: resolvedOptions.projectId,
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
      env: executionEnv,
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
      env: {},
    }),
  };
});

export function resolveCodingWorkerWorkspaceRoot(env: Record<string, unknown>): string {
  const configuredRoot =
    readOptionalEnv(env, 'GOROMBO_WORKSPACE_ROOT') ??
    readOptionalEnv(env, 'GOROMBO_CODING_WORKSPACE_ROOT') ??
    readOptionalEnv(env, 'GOROMBO_CODING_REPO_PATH');
  if (configuredRoot) {
    return configuredRoot;
  }
  return resolvePath('src/workspace');
}

function resolveApprovalRoot(
  options: CodingWorkerSubagentOptions,
  workspaceRoot: string | undefined,
): string | undefined {
  if (options.approvalRoot) {
    return resolvePath(options.approvalRoot);
  }
  return resolvePath(homedir(), '.gorombo', 'approvals');
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
    GOROMBO_GITHUB_AUTH_ROOT: readOptionalEnv(env, 'GOROMBO_GITHUB_AUTH_ROOT'),
  };
}

function withoutGithubCredentials(
  env: Record<string, string | undefined> | undefined,
): Record<string, string | undefined> | undefined {
  if (!env) return undefined;
  const filtered = { ...env };
  for (const key of githubRawTokenEnvironmentKeys) {
    delete filtered[key];
  }
  delete filtered.GH_CONFIG_DIR;
  for (const key of Object.keys(filtered)) {
    if (key.startsWith('GIT_CONFIG_')) {
      delete filtered[key];
    }
  }
  return filtered;
}

function createLazyGithubClient(load: () => Promise<GitHubClient>): GitHubClient {
  return new Proxy({} as GitHubClient, {
    get(_target, property) {
      if (property === 'then' || typeof property !== 'string') return undefined;
      return async (...args: unknown[]) => {
        const client = await load();
        const method = (client as unknown as Record<string, unknown>)[property];
        if (typeof method !== 'function') {
          throw new Error(`GitHub client method is unavailable: ${property}`);
        }
        return method.apply(client, args);
      };
    },
  });
}

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

export { createCodingWorkerLoopDelegate } from '../../../engine/workers/coding-worker/workflow/loop.js';

function readOptionalEnv(env: Record<string, unknown>, key: string): string | undefined {
  const value = env[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
