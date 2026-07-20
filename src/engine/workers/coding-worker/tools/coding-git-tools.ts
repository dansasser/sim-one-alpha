import { createHash } from 'node:crypto';
import { defineTool, type ToolDefinition } from '@flue/runtime';
import * as v from 'valibot';
import {
  createInMemoryCodingApprovalService,
  type CodingApprovalService,
} from '../../../../engine/workers/coding-worker/approvals/approval-service.js';
import { createCodingApprovalRequest } from '../../../../engine/workers/coding-worker/approvals/approval-policy.js';
import type {
  CodingApprovalActionType,
  CodingApprovalRequest,
} from '../../../../engine/workers/coding-worker/approvals/approval-types.js';
import {
  createFlueLocalCodingSandbox,
  type CodingSandboxRuntime,
} from '../../../../engine/workers/coding-worker/tools/sandbox-runtime.js';
import type { CodingProgressReporter } from '../../../../engine/workers/coding-worker/events/progress-reporter.js';
import type { CodingWorkspaceTargetInput } from '../../../../engine/workers/coding-worker/repo/workspace-target.js';
import type { CodingGithubAction } from '../../../../core/schemas/coding-worker.js';
import { githubCredentialOptions } from './github-credential-utils.js';

export interface CodingGitToolsOptions extends CodingWorkspaceTargetInput {
  env?: Record<string, string | undefined>;
  sandbox?: CodingSandboxRuntime;
  sessionId?: string;
  approvalService?: CodingApprovalService;
  reporter?: CodingProgressReporter;
  githubGitEnv?: () => Promise<Record<string, string>>;
}

export function createCodingGitTools(options: CodingGitToolsOptions): ToolDefinition[] {
  let sandboxPromise: Promise<CodingSandboxRuntime> | undefined;
  const approvalService = options.approvalService ?? createInMemoryCodingApprovalService();
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

  return [
    defineTool({
      name: 'coding_git_status',
      description: 'Read git status for the selected coding-worker project/repo scope.',
      parameters: v.object({}),
      execute: async () => {
        const sandbox = await getSandbox();
        const result = await sandbox.exec('git status --short --branch', { timeoutSeconds: 30 });
        return toToolJson(result);
      },
    }),
    defineTool({
      name: 'coding_git_diff',
      description: 'Read git diff for the selected coding-worker project/repo scope.',
      parameters: v.object({
        statOnly: v.optional(v.boolean()),
      }),
      execute: async (args) => {
        const sandbox = await getSandbox();
        const command = args.statOnly === true ? 'git diff --stat' : 'git diff';
        const result = await sandbox.exec(command, { timeoutSeconds: 30 });
        return toToolJson(result);
      },
    }),
    defineTool({
      name: 'coding_git_commit',
      description:
        'Approval-gated git commit. Requires an approval decision for the deterministic request id `${taskId}:git.commit`.',
      parameters: v.object({
        taskId: v.string(),
        message: v.string(),
        paths: v.optional(v.array(v.string())),
      }),
      execute: async (args) => {
        const taskId = requireString(args.taskId, 'taskId');
        const paths = readStringArray(args.paths);
        const approval = await evaluateGitApproval(options, {
          approvalService,
          taskId,
          actionType: 'git.commit',
          summary: `Commit local changes: ${requireString(args.message, 'message')}`,
          reason: 'Committing records local repository state.',
          risk: 'This mutates git history in the local branch.',
          target: paths.length ? paths.join(', ') : 'all tracked workspace changes',
        });
        if (!approval.evaluation.allowed) {
          return toToolJson({
            blocked: true,
            request: approval.request,
            evaluation: approval.evaluation,
          });
        }

        const sandbox = await getSandbox();
        const add = await sandbox.execFile('git', paths.length ? ['add', '--', ...paths] : ['add', '-A'], {
          timeoutSeconds: 30,
        });
        if (add.exitCode !== 0) {
          return toToolJson({ status: 'failed', step: 'git add', add });
        }

        const commit = await sandbox.execFile('git', ['commit', '-m', requireString(args.message, 'message')], {
          timeoutSeconds: 60,
        });
        return toToolJson({ status: commit.exitCode === 0 ? 'committed' : 'failed', add, commit });
      },
    }),
    defineTool({
      name: 'coding_git_push',
      description:
        'Approval-gated git push. Requires an approval decision for the deterministic request id `${taskId}:git.push`.',
      parameters: v.object({
        taskId: v.string(),
        remote: v.optional(v.string()),
        branch: v.string(),
      }),
      execute: async (args) => {
        const taskId = requireString(args.taskId, 'taskId');
        const remote = readString(args.remote) ?? 'origin';
        const branch = requireString(args.branch, 'branch');
        const approval = await evaluateGitApproval(options, {
          approvalService,
          taskId,
          actionType: 'git.push',
          summary: `Push ${branch} to ${remote}.`,
          reason: 'Pushing publishes branch state to the remote.',
          risk: 'This mutates remote repository state.',
          target: `${remote}/${branch}`,
          metadata: {
            remote,
            branch,
          },
        });
        if (!approval.evaluation.allowed) {
          return toToolJson({
            blocked: true,
            request: approval.request,
            evaluation: approval.evaluation,
          });
        }

        const sandbox = await getSandbox();
        const push = await sandbox.execFile('git', ['push', '-u', remote, branch], {
          timeoutSeconds: 120,
          ...(await githubCredentialOptions(sandbox, remote, options.githubGitEnv, 'push')),
        });
        return toToolJson({ status: push.exitCode === 0 ? 'pushed' : 'failed', push });
      },
    }),
    defineTool({
      name: 'coding_github_create_pr',
      description:
        'Approval-gated GitHub PR creation through gh CLI. Requires approval for `${taskId}:github.pr.create`.',
      parameters: v.object({
        taskId: v.string(),
        title: v.string(),
        body: v.string(),
        base: v.optional(v.string()),
        head: v.optional(v.string()),
        draft: v.optional(v.boolean()),
      }),
      execute: async (args) => {
        const taskId = requireString(args.taskId, 'taskId');
        const base = readString(args.base);
        const head = readString(args.head);
        const prPayload = {
          title: requireString(args.title, 'title'),
          body: requireString(args.body, 'body'),
          base,
          head,
          draft: args.draft !== false,
        };
        const approval = await evaluateGitApproval(options, {
          approvalService,
          taskId,
          actionType: 'github.pr.create',
          summary: `Create GitHub PR: ${prPayload.title} (${hashApprovalPayload(prPayload)})`,
          reason: 'Opening a PR publishes work to GitHub for review.',
          risk: 'This mutates remote GitHub state.',
          target: head ?? base ?? 'repository default branch',
          metadata: {
            draft: prPayload.draft,
            ...(base ? { base } : {}),
            ...(head ? { head } : {}),
            payloadHash: hashApprovalPayload(prPayload),
          },
        });
        if (!approval.evaluation.allowed) {
          return toGithubResult({
            action: 'create_pr',
            payload: {
              blocked: true,
              request: approval.request,
              evaluation: approval.evaluation,
            },
          });
        }

        const flags = [
          'pr',
          'create',
          args.draft === false ? undefined : '--draft',
          '--title',
          requireString(args.title, 'title'),
          '--body',
          requireString(args.body, 'body'),
          base ? ['--base', base] : undefined,
          head ? ['--head', head] : undefined,
        ].filter(Boolean);
        const sandbox = await getSandbox();
        const pr = await sandbox.execFile('gh', flags.flat() as string[], {
          timeoutSeconds: 120,
          ...(options.githubGitEnv ? { env: await options.githubGitEnv() } : {}),
        });
        return toGithubResult({
          action: 'create_pr',
          payload: {
            status: pr.exitCode === 0 ? 'created' : 'failed',
            ...(base ? { base } : {}),
            ...(head ? { head } : {}),
            draft: prPayload.draft,
            pr,
          },
        });
      },
    }),
  ];
}

function hashApprovalPayload(payload: Record<string, unknown>): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(payload, Object.keys(payload).sort()))
    .digest('hex')
    .slice(0, 12);
  return digest;
}

export async function evaluateGitApproval(
  options: { reporter?: CodingProgressReporter },
  input: {
  approvalService: CodingApprovalService;
  taskId: string;
  actionType: CodingApprovalActionType;
  summary: string;
  reason: string;
  risk: string;
  target?: string;
  expiresAt?: string;
  metadata?: Record<string, string | number | boolean>;
  },
) {
  const proposedRequest = createCodingApprovalRequest({
    taskId: input.taskId,
    actionType: input.actionType,
    summary: input.summary,
    reason: input.reason,
    risk: input.risk,
    target: input.target,
    expiresAt: input.expiresAt,
    metadata: input.metadata,
  });
  const latest = (await input.approvalService.listRecords(proposedRequest.taskId))
    .filter((record) => record.request.dedupeKey === proposedRequest.dedupeKey)
    .sort((left, right) => right.request.createdAt.localeCompare(left.request.createdAt))[0];
  if (latest) {
    const evaluation = await input.approvalService.evaluateRequest(latest.request);
    if (evaluation.allowed) {
      return { request: latest.request, evaluation };
    }
  }
  const request = await input.approvalService.createRequest({
    taskId: input.taskId,
    actionType: input.actionType,
    summary: input.summary,
    reason: input.reason,
    risk: input.risk,
    target: input.target,
    expiresAt: input.expiresAt,
    metadata: input.metadata,
  });
  const evaluation = await input.approvalService.evaluateRequest(request);
  if (!evaluation.allowed && evaluation.requiresApproval) {
    emitApprovalRequested(options, request, evaluation.reason);
  }
  return {
    request,
    evaluation,
  };
}

function emitApprovalRequested(
  options: CodingGitToolsOptions,
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

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function toToolJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function toGithubResult(action: CodingGithubAction): string {
  return toToolJson({ actions: [action] });
}
