import { defineTool, Type, type ToolDefinition } from '@flue/runtime';
import {
  createCodingApprovalRequest,
  evaluateCodingApproval,
} from '../approvals/approval-policy.js';
import type {
  CodingApprovalActionType,
  CodingApprovalDecision,
  CodingApprovalRequest,
} from '../approvals/approval-types.js';
import {
  createFlueLocalCodingSandbox,
  type CodingSandboxRuntime,
} from './sandbox-runtime.js';
import type { CodingWorkspaceTargetInput } from '../repo/workspace-target.js';

export interface CodingGitToolsOptions extends CodingWorkspaceTargetInput {
  env?: Record<string, string | undefined>;
  sandbox?: CodingSandboxRuntime;
  sessionId?: string;
  resolveApprovalDecision?: (
    request: CodingApprovalRequest,
  ) => Promise<CodingApprovalDecision | undefined> | CodingApprovalDecision | undefined;
}

export function createCodingGitTools(options: CodingGitToolsOptions): ToolDefinition[] {
  let sandboxPromise: Promise<CodingSandboxRuntime> | undefined;
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
      parameters: Type.Object({}),
      execute: async () => {
        const sandbox = await getSandbox();
        const result = await sandbox.exec('git status --short --branch', { timeoutSeconds: 30 });
        return toToolJson(result);
      },
    }),
    defineTool({
      name: 'coding_git_diff',
      description: 'Read git diff for the selected coding-worker project/repo scope.',
      parameters: Type.Object({
        statOnly: Type.Optional(Type.Boolean()),
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
      parameters: Type.Object({
        taskId: Type.String(),
        message: Type.String(),
        paths: Type.Optional(Type.Array(Type.String())),
      }),
      execute: async (args) => {
        const taskId = requireString(args.taskId, 'taskId');
        const approval = await evaluateGitApproval(options, {
          taskId,
          actionType: 'git.commit',
          summary: `Commit local changes: ${requireString(args.message, 'message')}`,
          reason: 'Committing records local repository state.',
          risk: 'This mutates git history in the local branch.',
        });
        if (!approval.evaluation.allowed) {
          return toToolJson({
            blocked: true,
            request: approval.request,
            evaluation: approval.evaluation,
          });
        }

        const sandbox = await getSandbox();
        const paths = readStringArray(args.paths);
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
      parameters: Type.Object({
        taskId: Type.String(),
        remote: Type.Optional(Type.String()),
        branch: Type.String(),
      }),
      execute: async (args) => {
        const taskId = requireString(args.taskId, 'taskId');
        const remote = readString(args.remote) ?? 'origin';
        const branch = requireString(args.branch, 'branch');
        const approval = await evaluateGitApproval(options, {
          taskId,
          actionType: 'git.push',
          summary: `Push ${branch} to ${remote}.`,
          reason: 'Pushing publishes branch state to the remote.',
          risk: 'This mutates remote repository state.',
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
        });
        return toToolJson({ status: push.exitCode === 0 ? 'pushed' : 'failed', push });
      },
    }),
    defineTool({
      name: 'coding_github_create_pr',
      description:
        'Approval-gated GitHub PR creation through gh CLI. Requires approval for `${taskId}:github.pr.create`.',
      parameters: Type.Object({
        taskId: Type.String(),
        title: Type.String(),
        body: Type.String(),
        base: Type.Optional(Type.String()),
        head: Type.Optional(Type.String()),
        draft: Type.Optional(Type.Boolean()),
      }),
      execute: async (args) => {
        const taskId = requireString(args.taskId, 'taskId');
        const approval = await evaluateGitApproval(options, {
          taskId,
          actionType: 'github.pr.create',
          summary: `Create GitHub PR: ${requireString(args.title, 'title')}`,
          reason: 'Opening a PR publishes work to GitHub for review.',
          risk: 'This mutates remote GitHub state.',
        });
        if (!approval.evaluation.allowed) {
          return toToolJson({
            blocked: true,
            request: approval.request,
            evaluation: approval.evaluation,
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
          readString(args.base) ? ['--base', readString(args.base) ?? ''] : undefined,
          readString(args.head) ? ['--head', readString(args.head) ?? ''] : undefined,
        ].filter(Boolean);
        const sandbox = await getSandbox();
        const pr = await sandbox.execFile('gh', flags.flat() as string[], { timeoutSeconds: 120 });
        return toToolJson({ status: pr.exitCode === 0 ? 'created' : 'failed', pr });
      },
    }),
  ];
}

async function evaluateGitApproval(
  options: CodingGitToolsOptions,
  input: {
  taskId: string;
  actionType: CodingApprovalActionType;
  summary: string;
  reason: string;
  risk: string;
  },
) {
  const request = createCodingApprovalRequest({
    taskId: input.taskId,
    actionType: input.actionType,
    summary: input.summary,
    reason: input.reason,
    risk: input.risk,
  });
  const decision = await options.resolveApprovalDecision?.(request);
  return {
    request,
    evaluation: evaluateCodingApproval(request, decision),
  };
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
