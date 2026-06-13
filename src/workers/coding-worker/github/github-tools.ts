import { createHash } from 'node:crypto';
import { defineTool, Type, type ToolDefinition } from '@flue/runtime';
import {
  createInMemoryCodingApprovalService,
  type CodingApprovalService,
} from '../approvals/approval-service.js';
import type { CodingApprovalActionType, CodingApprovalMetadata, CodingApprovalRequest } from '../approvals/approval-types.js';
import type { CodingProgressReporter } from '../events/progress-reporter.js';
import type {
  GitHubClient,
  GithubCheckSummary,
  GithubPullRequestSummary,
} from './github-client.js';

export interface CodingGitHubToolsOptions {
  client?: GitHubClient;
  approvalService?: CodingApprovalService;
  reporter?: CodingProgressReporter;
}

export function createCodingGitHubTools(input?: GitHubClient | CodingGitHubToolsOptions): ToolDefinition[] {
  const options = normalizeGitHubToolOptions(input);
  const approvalService = options.approvalService ?? createInMemoryCodingApprovalService();

  return [
    defineTool({
      name: 'coding_github_read_context',
      description:
        'Read GitHub issue, pull request, and check context for a coding-worker task. This is a read-only GitHub capability.',
      parameters: Type.Object({
        owner: Type.String(),
        repo: Type.String(),
        issueNumber: Type.Optional(Type.Number()),
        pullRequestNumber: Type.Optional(Type.Number()),
      }),
      execute: async (args) => {
        const client = options.client;
        if (!client) {
          return JSON.stringify({
            available: false,
            summary: 'No GitHub client is attached to this worker run.',
          });
        }

        const output: Record<string, unknown> = { available: true };
        try {
          if (typeof args.issueNumber === 'number') {
            output.issue = await client.getIssue(args.owner, args.repo, args.issueNumber);
          }
          if (typeof args.pullRequestNumber === 'number') {
            output.pullRequest = await client.getPullRequest(args.owner, args.repo, args.pullRequestNumber);
            output.checks = await client.listPullRequestChecks(args.owner, args.repo, args.pullRequestNumber);
            output.comments = client.listPullRequestComments
              ? await client.listPullRequestComments(args.owner, args.repo, args.pullRequestNumber)
              : [];
            output.reviewThreads = client.listPullRequestReviewThreads
              ? await client.listPullRequestReviewThreads(args.owner, args.repo, args.pullRequestNumber)
              : [];
          }
        } catch (error) {
          return JSON.stringify({
            available: false,
            summary: 'GitHub context is unavailable for this worker run.',
            error: formatToolError(error),
          });
        }
        return JSON.stringify(output);
      },
    }),
    defineTool({
      name: 'coding_github_verify_pr',
      description:
        'Read and verify GitHub PR base, head, draft status, and optionally checks for a coding-worker task.',
      parameters: Type.Object({
        owner: Type.String(),
        repo: Type.String(),
        pullRequestNumber: Type.Number(),
        expectedBase: Type.Optional(Type.String()),
        expectedHead: Type.Optional(Type.String()),
        expectedDraft: Type.Optional(Type.Boolean()),
        requireChecksPassed: Type.Optional(Type.Boolean()),
      }),
      execute: async (args) => {
        const client = options.client;
        if (!client) {
          return JSON.stringify({
            available: false,
            verified: false,
            summary: 'No GitHub client is attached to this worker run.',
          });
        }

        try {
          const pullRequest = await client.getPullRequest(args.owner, args.repo, args.pullRequestNumber);
          const checks = args.requireChecksPassed === true
            ? await client.listPullRequestChecks(args.owner, args.repo, args.pullRequestNumber)
            : [];
          const mismatches = verifyPullRequestMetadata({
            pullRequest,
            checks,
            expectedBase: readString(args.expectedBase),
            expectedHead: readString(args.expectedHead),
            expectedDraft: typeof args.expectedDraft === 'boolean' ? args.expectedDraft : undefined,
            requireChecksPassed: args.requireChecksPassed === true,
          });
          return JSON.stringify({
            available: true,
            verified: mismatches.length === 0,
            pullRequest,
            checks,
            mismatches,
          });
        } catch (error) {
          return JSON.stringify({
            available: false,
            verified: false,
            summary: 'GitHub PR verification is unavailable for this worker run.',
            error: formatToolError(error),
          });
        }
      },
    }),
    defineTool({
      name: 'coding_github_request_approval',
      description:
        'Create an approval request for a GitHub, git, or repo side effect. This tool does not perform the side effect.',
      parameters: Type.Object({
        taskId: Type.String(),
        actionType: Type.Union([
          Type.Literal('git.commit'),
          Type.Literal('git.push'),
          Type.Literal('github.comment'),
          Type.Literal('github.pr.create'),
          Type.Literal('github.pr.update'),
          Type.Literal('github.pr.ready'),
          Type.Literal('github.issue.update'),
          Type.Literal('github.review-thread.update'),
          Type.Literal('repo.clone'),
          Type.Literal('repo.register'),
          Type.Literal('repo.branch.create'),
          Type.Literal('repo.worktree.create'),
          Type.Literal('repo.fetch'),
          Type.Literal('repo.sync'),
        ]),
        summary: Type.String(),
        reason: Type.String(),
        risk: Type.String(),
        target: Type.Optional(Type.String()),
      }),
      execute: async (args) => {
        const request = await approvalService.createRequest({
          taskId: args.taskId,
          actionType: args.actionType,
          summary: args.summary,
          reason: args.reason,
          risk: args.risk,
          target: readString(args.target),
        });
        const evaluation = await approvalService.evaluateRequest(request);
        if (!evaluation.allowed && evaluation.requiresApproval) {
          emitApprovalRequested(options, request, evaluation.reason);
        }
        return JSON.stringify({
          request,
          evaluation,
        });
      },
    }),
    defineTool({
      name: 'coding_github_update_pr',
      description: 'Approval-gated GitHub PR metadata update through the configured GitHub client.',
      parameters: Type.Object({
        taskId: Type.String(),
        owner: Type.String(),
        repo: Type.String(),
        pullRequestNumber: Type.Number(),
        title: Type.Optional(Type.String()),
        body: Type.Optional(Type.String()),
        base: Type.Optional(Type.String()),
      }),
      execute: async (args) => {
        if (!options.client?.updatePullRequest) {
          return unavailableWriteTool();
        }
        const prUpdatePayload = {
          title: readString(args.title),
          body: readString(args.body),
          base: readString(args.base),
        };
        const approval = await evaluateGitHubApproval(approvalService, options, {
          taskId: args.taskId,
          actionType: 'github.pr.update',
          summary: `Update GitHub PR #${args.pullRequestNumber} (${hashApprovalPayload(prUpdatePayload)})`,
          reason: 'Updating PR metadata mutates remote GitHub state.',
          risk: 'This can change review context, PR body, title, or target base.',
          target: `${args.owner}/${args.repo}#${args.pullRequestNumber}`,
          metadata: {
            ...(prUpdatePayload.title ? { title: prUpdatePayload.title } : {}),
            ...(prUpdatePayload.body ? { body: prUpdatePayload.body } : {}),
            ...(prUpdatePayload.base ? { base: prUpdatePayload.base } : {}),
            payloadHash: hashApprovalPayload(prUpdatePayload),
          },
        });
        if (!approval.evaluation.allowed) {
          return JSON.stringify({ blocked: true, ...approval });
        }
        const result = await options.client.updatePullRequest({
          owner: args.owner,
          repo: args.repo,
          pullRequestNumber: args.pullRequestNumber,
          title: readString(args.title),
          body: readString(args.body),
          base: readString(args.base),
        });
        return JSON.stringify({ status: result.status, result });
      },
    }),
    defineTool({
      name: 'coding_github_set_pr_ready',
      description: 'Approval-gated GitHub PR ready/draft status update.',
      parameters: Type.Object({
        taskId: Type.String(),
        owner: Type.String(),
        repo: Type.String(),
        pullRequestNumber: Type.Number(),
        ready: Type.Boolean(),
      }),
      execute: async (args) => {
        if (!options.client?.setPullRequestReady) {
          return unavailableWriteTool();
        }
        const readyPayload = { ready: args.ready };
        const approval = await evaluateGitHubApproval(approvalService, options, {
          taskId: args.taskId,
          actionType: 'github.pr.ready',
          summary: `${args.ready ? 'Mark ready' : 'Convert to draft'} GitHub PR #${args.pullRequestNumber} (${hashApprovalPayload(readyPayload)})`,
          reason: 'Changing ready/draft state affects remote review automation and reviewer visibility.',
          risk: 'This mutates remote GitHub PR state.',
          target: `${args.owner}/${args.repo}#${args.pullRequestNumber}`,
          metadata: {
            ready: args.ready,
            payloadHash: hashApprovalPayload(readyPayload),
          },
        });
        if (!approval.evaluation.allowed) {
          return JSON.stringify({ blocked: true, ...approval });
        }
        const result = await options.client.setPullRequestReady({
          owner: args.owner,
          repo: args.repo,
          pullRequestNumber: args.pullRequestNumber,
          ready: args.ready,
        });
        return JSON.stringify({ status: result.status, result });
      },
    }),
    defineTool({
      name: 'coding_github_comment_pr',
      description: 'Approval-gated GitHub PR comment creation.',
      parameters: Type.Object({
        taskId: Type.String(),
        owner: Type.String(),
        repo: Type.String(),
        pullRequestNumber: Type.Number(),
        body: Type.String(),
      }),
      execute: async (args) => {
        if (!options.client?.commentOnPullRequest) {
          return unavailableWriteTool();
        }
        const commentPayload = { body: args.body };
        const approval = await evaluateGitHubApproval(approvalService, options, {
          taskId: args.taskId,
          actionType: 'github.comment',
          summary: `Comment on GitHub PR #${args.pullRequestNumber} (${hashApprovalPayload(commentPayload)})`,
          reason: 'Posting a PR comment publishes remote GitHub state.',
          risk: 'This may notify users and affect review context.',
          target: `${args.owner}/${args.repo}#${args.pullRequestNumber}`,
          metadata: {
            payloadHash: hashApprovalPayload(commentPayload),
          },
        });
        if (!approval.evaluation.allowed) {
          return JSON.stringify({ blocked: true, ...approval });
        }
        const result = await options.client.commentOnPullRequest({
          owner: args.owner,
          repo: args.repo,
          pullRequestNumber: args.pullRequestNumber,
          body: args.body,
        });
        return JSON.stringify({ status: result.status, result });
      },
    }),
    defineTool({
      name: 'coding_github_update_issue',
      description: 'Approval-gated GitHub issue metadata update.',
      parameters: Type.Object({
        taskId: Type.String(),
        owner: Type.String(),
        repo: Type.String(),
        issueNumber: Type.Number(),
        title: Type.Optional(Type.String()),
        body: Type.Optional(Type.String()),
      }),
      execute: async (args) => {
        if (!options.client?.updateIssue) {
          return unavailableWriteTool();
        }
        const issuePayload = {
          title: readString(args.title),
          body: readString(args.body),
        };
        const approval = await evaluateGitHubApproval(approvalService, options, {
          taskId: args.taskId,
          actionType: 'github.issue.update',
          summary: `Update GitHub issue #${args.issueNumber} (${hashApprovalPayload(issuePayload)})`,
          reason: 'Updating issue metadata mutates remote GitHub state.',
          risk: 'This can change user-facing issue context.',
          target: `${args.owner}/${args.repo}#${args.issueNumber}`,
          metadata: {
            ...(issuePayload.title ? { title: issuePayload.title } : {}),
            ...(issuePayload.body ? { body: issuePayload.body } : {}),
            payloadHash: hashApprovalPayload(issuePayload),
          },
        });
        if (!approval.evaluation.allowed) {
          return JSON.stringify({ blocked: true, ...approval });
        }
        const result = await options.client.updateIssue({
          owner: args.owner,
          repo: args.repo,
          issueNumber: args.issueNumber,
          title: readString(args.title),
          body: readString(args.body),
        });
        return JSON.stringify({ status: result.status, result });
      },
    }),
    defineTool({
      name: 'coding_github_update_review_thread',
      description: 'Approval-gated GitHub PR review-thread reply or resolution update.',
      parameters: Type.Object({
        taskId: Type.String(),
        threadId: Type.String(),
        replyBody: Type.Optional(Type.String()),
        resolve: Type.Optional(Type.Boolean()),
      }),
      execute: async (args) => {
        if (!options.client?.updateReviewThread) {
          return unavailableWriteTool();
        }
        const threadPayload = {
          replyBody: readString(args.replyBody),
          resolve: typeof args.resolve === 'boolean' ? args.resolve : undefined,
        };
        const approval = await evaluateGitHubApproval(approvalService, options, {
          taskId: args.taskId,
          actionType: 'github.review-thread.update',
          summary: `Update GitHub review thread ${args.threadId} (${hashApprovalPayload(threadPayload)})`,
          reason: 'Review-thread replies and resolution mutate remote review state.',
          risk: 'This affects reviewer-visible PR review state.',
          target: args.threadId,
          metadata: {
            ...(threadPayload.replyBody ? { replyBody: threadPayload.replyBody } : {}),
            ...(threadPayload.resolve !== undefined ? { resolve: threadPayload.resolve } : {}),
            payloadHash: hashApprovalPayload(threadPayload),
          },
        });
        if (!approval.evaluation.allowed) {
          return JSON.stringify({ blocked: true, ...approval });
        }
        const result = await options.client.updateReviewThread({
          threadId: args.threadId,
          replyBody: readString(args.replyBody),
          resolve: typeof args.resolve === 'boolean' ? args.resolve : undefined,
        });
        return JSON.stringify({ status: result.status, result });
      },
    }),
  ];
}

function normalizeGitHubToolOptions(input?: GitHubClient | CodingGitHubToolsOptions): CodingGitHubToolsOptions {
  if (!input) {
    return {};
  }
  return 'getIssue' in input ? { client: input } : input;
}

async function evaluateGitHubApproval(
  approvalService: CodingApprovalService,
  options: CodingGitHubToolsOptions,
  input: {
    taskId: string;
    actionType: CodingApprovalActionType;
    summary: string;
    reason: string;
    risk: string;
    target?: string;
    metadata?: CodingApprovalMetadata;
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
  options: CodingGitHubToolsOptions,
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

function hashApprovalPayload(payload: Record<string, unknown>): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(payload, Object.keys(payload).sort()))
    .digest('hex')
    .slice(0, 12);
  return digest;
}

function unavailableWriteTool(): string {
  return JSON.stringify({
    available: false,
    blocked: true,
    summary: 'No GitHub write client is attached to this worker run.',
  });
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function verifyPullRequestMetadata(input: {
  pullRequest: GithubPullRequestSummary;
  checks: GithubCheckSummary[];
  expectedBase?: string;
  expectedHead?: string;
  expectedDraft?: boolean;
  requireChecksPassed: boolean;
}): string[] {
  const mismatches: string[] = [];
  if (input.expectedBase && input.pullRequest.baseRef !== input.expectedBase) {
    mismatches.push(`Expected base ${input.expectedBase}, got ${input.pullRequest.baseRef ?? 'unknown'}.`);
  }
  if (input.expectedHead && input.pullRequest.headRef !== input.expectedHead) {
    mismatches.push(`Expected head ${input.expectedHead}, got ${input.pullRequest.headRef ?? 'unknown'}.`);
  }
  if (
    input.expectedDraft !== undefined &&
    input.pullRequest.isDraft !== input.expectedDraft
  ) {
    mismatches.push(
      `Expected draft status ${String(input.expectedDraft)}, got ${String(input.pullRequest.isDraft)}.`,
    );
  }
  if (input.requireChecksPassed) {
    const failingChecks = input.checks.filter(
      (check) => check.status !== 'COMPLETED' || check.conclusion !== 'SUCCESS',
    );
    if (failingChecks.length > 0) {
      mismatches.push(`Checks are not passing: ${failingChecks.map((check) => check.name).join(', ')}.`);
    }
  }
  return mismatches;
}

function formatToolError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
