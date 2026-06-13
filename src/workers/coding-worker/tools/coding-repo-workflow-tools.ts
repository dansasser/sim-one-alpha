import { defineTool, Type, type ToolDefinition } from '@flue/runtime';
import {
  createInMemoryCodingApprovalService,
  type CodingApprovalService,
} from '../approvals/approval-service.js';
import type { CodingApprovalActionType, CodingApprovalRequest } from '../approvals/approval-types.js';
import type { CodingProgressReporter } from '../events/progress-reporter.js';
import { parseGitStatusShort } from '../repo/git-state.js';
import {
  createRegisteredRepo,
  InMemoryCodingRepoRegistry,
  JsonFileCodingRepoRegistry,
  type CodingRegisteredRepo,
  type CodingRepoRegistry,
} from '../repo/repo-registry.js';
import {
  normalizeAgentRelativePath,
  normalizeProjectSlug,
  type CodingWorkspaceTargetInput,
} from '../repo/workspace-target.js';
import {
  createFlueLocalCodingSandbox,
  type CodingSandboxRuntime,
} from './sandbox-runtime.js';

export interface CodingRepoWorkflowToolsOptions extends CodingWorkspaceTargetInput {
  env?: Record<string, string | undefined>;
  sandbox?: CodingSandboxRuntime;
  sessionId?: string;
  approvalService?: CodingApprovalService;
  repoRegistry?: CodingRepoRegistry;
  reporter?: CodingProgressReporter;
}

export function createCodingRepoWorkflowTools(options: CodingRepoWorkflowToolsOptions): ToolDefinition[] {
  let sandboxPromise: Promise<CodingSandboxRuntime> | undefined;
  const approvalService = options.approvalService ?? createInMemoryCodingApprovalService();
  let repoRegistryPromise: Promise<CodingRepoRegistry> | undefined;
  const getSandbox = async () => {
    sandboxPromise ??= options.sandbox
      ? Promise.resolve(options.sandbox)
      : createFlueLocalCodingSandbox({
          workspaceRoot: options.workspaceRoot,
          targetKind: options.targetKind,
          projectId: options.projectId,
          projectSlug: options.projectSlug,
          projectRelativePath: options.projectRelativePath,
          repoPath: options.repoPath,
          env: options.env,
          sessionId: options.sessionId,
        });
    return sandboxPromise;
  };
  const getRepoRegistry = async () => {
    if (options.repoRegistry) {
      return options.repoRegistry;
    }
    repoRegistryPromise ??= getSandbox().then((sandbox) => {
      if (sandbox.workspaceRoot) {
        return JsonFileCodingRepoRegistry.atWorkspaceRoot(sandbox.workspaceRoot);
      }
      return new InMemoryCodingRepoRegistry();
    });
    return repoRegistryPromise;
  };

  return [
    defineTool({
      name: 'coding_repo_discover',
      description:
        'Discover registered and checked-out coding repositories under workspaceRoot/repos and workspaceRoot/projects.',
      parameters: Type.Object({}),
      execute: async () => {
        const sandbox = await getSandbox();
        const registry = await getRepoRegistry();
        const registered = await registry.list();
        const discovered = await discoverWorkspaceRepos(sandbox, registered);
        return toToolJson({
          workspaceRoot: sandbox.workspaceRoot,
          registered,
          discovered,
        });
      },
    }),
    defineTool({
      name: 'coding_repo_register',
      description:
        'Approval-gated registration of an existing workspace repository in the coding-worker repo registry.',
      parameters: Type.Object({
        taskId: Type.String(),
        slug: Type.String(),
        repoRelativePath: Type.String(),
        remoteUrl: Type.Optional(Type.String()),
        owner: Type.Optional(Type.String()),
        repo: Type.Optional(Type.String()),
        defaultBranch: Type.Optional(Type.String()),
      }),
      execute: async (args) => {
        const slug = normalizeProjectSlug(requireString(args.slug, 'slug'));
        const repoRelativePath = normalizeRepoWorkspaceRelativePath(
          requireString(args.repoRelativePath, 'repoRelativePath'),
        );
        const approval = await evaluateRepoApproval(approvalService, options, {
          taskId: requireString(args.taskId, 'taskId'),
          actionType: 'repo.register',
          summary: `Register repository ${slug}.`,
          reason: 'Registering a repository writes local coding-worker repo metadata.',
          risk: 'This mutates local worker registry state under the configured workspace root.',
          target: repoRelativePath,
        });
        if (!approval.evaluation.allowed) {
          return toToolJson({ blocked: true, ...approval });
        }
        const sandbox = await getSandbox();
        const gitMetadataExists = await sandbox.existsWorkspace(`${repoRelativePath}/.git`);
        if (!gitMetadataExists) {
          return toToolJson({
            status: 'failed',
            summary: 'Repository registration requires a git checkout or worktree.',
            repoRelativePath,
          });
        }
        const registry = await getRepoRegistry();
        const existing = await registry.get(slug);
        const record = createRegisteredRepo({
          slug,
          repoRelativePath,
          repoPath: sandbox.resolveWorkspacePath(repoRelativePath),
          remoteUrl: readString(args.remoteUrl),
          owner: readString(args.owner),
          repo: readString(args.repo),
          defaultBranch: readString(args.defaultBranch),
          existing,
        });
        await registry.upsert(record);
        return toToolJson({ status: 'registered', repo: record });
      },
    }),
    defineTool({
      name: 'coding_repo_clone',
      description:
        'Approval-gated git clone into workspaceRoot/repos/<slug> and registration in the coding-worker repo registry.',
      parameters: Type.Object({
        taskId: Type.String(),
        remoteUrl: Type.String(),
        slug: Type.Optional(Type.String()),
        branch: Type.Optional(Type.String()),
        owner: Type.Optional(Type.String()),
        repo: Type.Optional(Type.String()),
        defaultBranch: Type.Optional(Type.String()),
      }),
      execute: async (args) => {
        const remoteUrl = normalizeRepoUrl(requireString(args.remoteUrl, 'remoteUrl'));
        const slug = normalizeProjectSlug(readString(args.slug) ?? repoSlugFromRemote(remoteUrl));
        const branch = readString(args.branch);
        if (branch) {
          normalizeGitRef(branch, 'branch');
        }
        const repoRelativePath = `repos/${slug}`;
        const approval = await evaluateRepoApproval(approvalService, options, {
          taskId: requireString(args.taskId, 'taskId'),
          actionType: 'repo.clone',
          summary: `Clone ${remoteUrl} into ${repoRelativePath}.`,
          reason: 'Cloning creates a local repository checkout inside the coding workspace.',
          risk: 'This creates files under the configured workspace root and may run git network access.',
          target: repoRelativePath,
        });
        if (!approval.evaluation.allowed) {
          return toToolJson({ blocked: true, ...approval });
        }
        const sandbox = await getSandbox();
        if (await sandbox.existsWorkspace(repoRelativePath)) {
          return toToolJson({
            status: 'failed',
            summary: 'Clone target already exists.',
            repoRelativePath,
          });
        }
        await sandbox.mkdirWorkspace('repos', { recursive: true });
        const repoPath = sandbox.resolveWorkspacePath(repoRelativePath);
        const clone = await sandbox.execFile(
          'git',
          ['clone', ...(branch ? ['--branch', branch] : []), '--', remoteUrl, repoPath],
          { timeoutSeconds: 300 },
        );
        let record: CodingRegisteredRepo | undefined;
        if (clone.exitCode === 0) {
          const registry = await getRepoRegistry();
          record = createRegisteredRepo({
            slug,
            repoRelativePath,
            repoPath,
            remoteUrl,
            owner: readString(args.owner),
            repo: readString(args.repo),
            defaultBranch: readString(args.defaultBranch) ?? branch,
          });
          await registry.upsert(record);
        }
        return toToolJson({
          status: clone.exitCode === 0 ? 'cloned' : 'failed',
          repo: record,
          clone,
        });
      },
    }),
    defineTool({
      name: 'coding_repo_git_state',
      description: 'Read branch, dirty state, and changed files for the selected coding-worker repo scope.',
      parameters: Type.Object({}),
      execute: async () => {
        const sandbox = await getSandbox();
        const status = await sandbox.execFile('git', ['status', '--short', '--branch'], {
          timeoutSeconds: 30,
        });
        const branch = await sandbox.execFile('git', ['branch', '--show-current'], {
          timeoutSeconds: 30,
        });
        return toToolJson({
          git: parseGitStatusShort(status.stdout, branch.stdout.trim() || 'unknown'),
          status,
        });
      },
    }),
    defineTool({
      name: 'coding_repo_fetch',
      description: 'Approval-gated git fetch for the selected coding-worker repo scope.',
      parameters: Type.Object({
        taskId: Type.String(),
        remote: Type.Optional(Type.String()),
        prune: Type.Optional(Type.Boolean()),
      }),
      execute: async (args) => {
        const rawRemote = readString(args.remote) ?? 'origin';
        if (rawRemote.startsWith('-')) {
          return toInvalidOperandResult('remote', rawRemote);
        }
        const remote = rawRemote;
        const approval = await evaluateRepoApproval(approvalService, options, {
          taskId: requireString(args.taskId, 'taskId'),
          actionType: 'repo.fetch',
          summary: `Fetch ${remote}.`,
          reason: 'Fetching updates local remote-tracking refs.',
          risk: 'This mutates local repository metadata.',
          target: remote,
        });
        if (!approval.evaluation.allowed) {
          return toToolJson({ blocked: true, ...approval });
        }
        const sandbox = await getSandbox();
        const fetch = await sandbox.execFile('git', ['fetch', ...(args.prune === true ? ['--prune'] : []), remote], {
          timeoutSeconds: 120,
        });
        return toToolJson({ status: fetch.exitCode === 0 ? 'fetched' : 'failed', fetch });
      },
    }),
    defineTool({
      name: 'coding_repo_sync',
      description: 'Approval-gated git pull --ff-only for the selected coding-worker repo scope.',
      parameters: Type.Object({
        taskId: Type.String(),
        remote: Type.Optional(Type.String()),
        branch: Type.Optional(Type.String()),
        prune: Type.Optional(Type.Boolean()),
      }),
      execute: async (args) => {
        const rawRemote = readString(args.remote) ?? 'origin';
        if (rawRemote.startsWith('-')) {
          return toInvalidOperandResult('remote', rawRemote);
        }
        const remote = rawRemote;
        const branch = readString(args.branch);
        if (branch) {
          normalizeGitRef(branch, 'branch');
        }
        const approval = await evaluateRepoApproval(approvalService, options, {
          taskId: requireString(args.taskId, 'taskId'),
          actionType: 'repo.sync',
          summary: `Sync ${remote}${branch ? `/${branch}` : ''}.`,
          reason: 'Syncing updates local repository refs and may update workspace files.',
          risk: 'This mutates local repository metadata and the selected working tree.',
          target: branch ? `${remote}/${branch}` : remote,
        });
        if (!approval.evaluation.allowed) {
          return toToolJson({ blocked: true, ...approval });
        }
        const sandbox = await getSandbox();
        const fetch = args.prune === true
          ? await sandbox.execFile('git', ['fetch', '--prune', remote], { timeoutSeconds: 120 })
          : undefined;
        if (fetch && fetch.exitCode !== 0) {
          return toToolJson({ status: 'failed', step: 'fetch', fetch });
        }
        const pull = await sandbox.execFile(
          'git',
          ['pull', '--ff-only', remote, ...(branch ? [branch] : [])],
          { timeoutSeconds: 120 },
        );
        return toToolJson({ status: pull.exitCode === 0 ? 'synced' : 'failed', fetch, pull });
      },
    }),
    defineTool({
      name: 'coding_repo_branch_create',
      description: 'Approval-gated branch creation in the selected coding-worker repo scope.',
      parameters: Type.Object({
        taskId: Type.String(),
        branch: Type.String(),
        startPoint: Type.Optional(Type.String()),
        checkout: Type.Optional(Type.Boolean()),
      }),
      execute: async (args) => {
        const branch = normalizeGitRef(requireString(args.branch, 'branch'), 'branch');
        const startPoint = readString(args.startPoint);
        if (startPoint !== undefined && startPoint.startsWith('-')) {
          return toInvalidOperandResult('startPoint', startPoint);
        }
        const approval = await evaluateRepoApproval(approvalService, options, {
          taskId: requireString(args.taskId, 'taskId'),
          actionType: 'repo.branch.create',
          summary: `Create branch ${branch}.`,
          reason: 'Creating a branch mutates local repository state.',
          risk: args.checkout === true
            ? 'This creates and checks out a local branch.'
            : 'This creates a local branch.',
          target: branch,
        });
        if (!approval.evaluation.allowed) {
          return toToolJson({ blocked: true, ...approval });
        }
        const sandbox = await getSandbox();
        const create = await sandbox.execFile('git', ['branch', branch, ...(startPoint ? [startPoint] : [])], {
          timeoutSeconds: 30,
        });
        const checkout = args.checkout === true && create.exitCode === 0
          ? await sandbox.execFile('git', ['checkout', branch], { timeoutSeconds: 30 })
          : undefined;
        return toToolJson({
          status: create.exitCode === 0 && (!checkout || checkout.exitCode === 0) ? 'created' : 'failed',
          create,
          checkout,
        });
      },
    }),
    defineTool({
      name: 'coding_repo_worktree_create',
      description: 'Approval-gated git worktree creation under workspaceRoot/repos/<slug>.',
      parameters: Type.Object({
        taskId: Type.String(),
        branch: Type.String(),
        directoryName: Type.Optional(Type.String()),
        startPoint: Type.Optional(Type.String()),
        createBranch: Type.Optional(Type.Boolean()),
      }),
      execute: async (args) => {
        const branch = normalizeGitRef(requireString(args.branch, 'branch'), 'branch');
        const rawStartPoint = readString(args.startPoint);
        if (rawStartPoint !== undefined && rawStartPoint.startsWith('-')) {
          return toInvalidOperandResult('startPoint', rawStartPoint);
        }
        const slug = normalizeProjectSlug(readString(args.directoryName) ?? branch);
        const worktreeRelativePath = `repos/${slug}`;
        const approval = await evaluateRepoApproval(approvalService, options, {
          taskId: requireString(args.taskId, 'taskId'),
          actionType: 'repo.worktree.create',
          summary: `Create worktree ${worktreeRelativePath} for ${branch}.`,
          reason: 'Creating a worktree mutates local repository metadata and creates files under the workspace.',
          risk: 'This creates a new checked-out working tree inside the configured workspace root.',
          target: worktreeRelativePath,
        });
        if (!approval.evaluation.allowed) {
          return toToolJson({ blocked: true, ...approval });
        }
        const sandbox = await getSandbox();
        const worktreePath = sandbox.resolveWorkspacePath(worktreeRelativePath);
        const startPoint = rawStartPoint;
        const argsList = [
          'worktree',
          'add',
          ...(args.createBranch === false ? [] : ['-b', branch]),
          worktreePath,
          ...(startPoint ? [startPoint] : args.createBranch === false ? [branch] : []),
        ];
        const worktree = await sandbox.execFile('git', argsList, { timeoutSeconds: 120 });
        return toToolJson({
          status: worktree.exitCode === 0 ? 'created' : 'failed',
          worktreeRelativePath,
          worktreePath,
          worktree,
        });
      },
    }),
  ];
}

async function evaluateRepoApproval(
  approvalService: CodingApprovalService,
  options: CodingRepoWorkflowToolsOptions,
  input: {
    taskId: string;
    actionType: CodingApprovalActionType;
    summary: string;
    reason: string;
    risk: string;
    target: string;
  },
) {
  const request = await approvalService.createRequest(input);
  const evaluation = await approvalService.evaluateRequest(request);
  if (!evaluation.allowed && evaluation.requiresApproval) {
    emitApprovalRequested(options, request, evaluation.reason);
  }
  return { request, evaluation };
}

function emitApprovalRequested(
  options: CodingRepoWorkflowToolsOptions,
  request: CodingApprovalRequest,
  reason: string,
): void {
  options.reporter?.emit({
    type: 'coding.approval.requested',
    taskId: request.taskId,
    action: request.actionType,
    summary: request.summary,
    approvalReason: request.reason,
    risk: request.risk,
    status: 'pending',
    decision: reason,
    evidence: [request.id],
  });
}

function normalizeGitRef(value: string, name: string): string {
  if (!value.trim() || /\s/.test(value) || value.startsWith('-') || value.includes('..')) {
    throw new Error(`Invalid git ${name}: ${value}`);
  }
  return value;
}

function rejectGitOperand(value: string | undefined, name: string): string | undefined {
  if (value === undefined || value.length === 0) {
    return value;
  }
  if (value.startsWith('-')) {
    throw new Error(`Invalid git ${name} operand: ${value}`);
  }
  return value;
}

function toInvalidOperandResult(name: string, value: string): ReturnType<typeof toToolJson> {
  return toToolJson({ blocked: true, reason: `invalid git operand for ${name}: ${value}` });
}

async function discoverWorkspaceRepos(
  sandbox: CodingSandboxRuntime,
  registered: CodingRegisteredRepo[],
): Promise<CodingRegisteredRepo[]> {
  const discovered = new Map<string, CodingRegisteredRepo>();
  for (const record of registered) {
    discovered.set(record.repoRelativePath, record);
  }

  for (const root of ['repos', 'projects']) {
    if (!(await sandbox.existsWorkspace(root))) {
      continue;
    }
    const entries = await sandbox.readdirWorkspace(root);
    for (const entry of entries) {
      const repoRelativePath = `${root}/${entry}`;
      const stat = await safeWorkspaceStat(sandbox, repoRelativePath);
      if (!stat?.isDirectory) {
        continue;
      }
      if (!(await sandbox.existsWorkspace(`${repoRelativePath}/.git`))) {
        continue;
      }
      const existing = discovered.get(repoRelativePath);
      discovered.set(
        repoRelativePath,
        existing ??
          createRegisteredRepo({
            slug: normalizeProjectSlug(entry),
            repoRelativePath,
            repoPath: sandbox.resolveWorkspacePath(repoRelativePath),
          }),
      );
    }
  }

  return [...discovered.values()].sort((left, right) =>
    left.repoRelativePath.localeCompare(right.repoRelativePath),
  );
}

async function safeWorkspaceStat(
  sandbox: CodingSandboxRuntime,
  path: string,
): Promise<{ isFile: boolean; isDirectory: boolean } | undefined> {
  try {
    return await sandbox.statWorkspace(path);
  } catch {
    return undefined;
  }
}

function normalizeRepoWorkspaceRelativePath(value: string): string {
  if (!value.trim() || value.includes('\0')) {
    throw new Error('repoRelativePath is required.');
  }
  const normalized = normalizeAgentRelativePath(value);
  if (
    normalized === '.' ||
    normalized.startsWith('../') ||
    normalized.includes('/../') ||
    (!normalized.startsWith('repos/') && !normalized.startsWith('projects/'))
  ) {
    throw new Error('repoRelativePath must point to workspaceRoot/repos/<slug> or workspaceRoot/projects/<slug>.');
  }
  return normalized;
}

function normalizeRepoUrl(value: string): string {
  if (!value.trim() || value.includes('\0') || value.startsWith('-')) {
    throw new Error(`Invalid git remoteUrl: ${value}`);
  }
  return value;
}

function repoSlugFromRemote(remoteUrl: string): string {
  const withoutTrailingSlash = remoteUrl.replace(/[\\/]+$/, '');
  const lastSegment = withoutTrailingSlash.split(/[/:\\]/).filter(Boolean).at(-1) ?? 'repo';
  return normalizeProjectSlug(lastSegment.replace(/\.git$/i, ''));
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function toToolJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
