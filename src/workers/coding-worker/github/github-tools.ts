import { defineTool, Type, type ToolDefinition } from '@flue/runtime';
import { createCodingApprovalRequest, evaluateCodingApproval } from '../approvals/approval-policy.js';
import type { GitHubClient } from './github-client.js';

export function createCodingGitHubTools(client?: GitHubClient): ToolDefinition[] {
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
        if (!client) {
          return JSON.stringify({
            available: false,
            summary: 'No GitHub client is attached to this worker run.',
          });
        }

        const output: Record<string, unknown> = { available: true };
        if (typeof args.issueNumber === 'number') {
          output.issue = await client.getIssue(args.owner, args.repo, args.issueNumber);
        }
        if (typeof args.pullRequestNumber === 'number') {
          output.pullRequest = await client.getPullRequest(args.owner, args.repo, args.pullRequestNumber);
          output.checks = await client.listPullRequestChecks(args.owner, args.repo, args.pullRequestNumber);
        }
        return JSON.stringify(output);
      },
    }),
    defineTool({
      name: 'coding_github_request_approval',
      description:
        'Create an approval request for a GitHub or git side effect. This tool does not perform the side effect.',
      parameters: Type.Object({
        taskId: Type.String(),
        actionType: Type.Union([
          Type.Literal('git.push'),
          Type.Literal('github.comment'),
          Type.Literal('github.pr.create'),
          Type.Literal('github.pr.update'),
          Type.Literal('github.review-thread.update'),
        ]),
        summary: Type.String(),
        reason: Type.String(),
        risk: Type.String(),
      }),
      execute: async (args) => {
        const request = createCodingApprovalRequest({
          taskId: args.taskId,
          actionType: args.actionType,
          summary: args.summary,
          reason: args.reason,
          risk: args.risk,
        });
        return JSON.stringify({
          request,
          evaluation: evaluateCodingApproval(request),
        });
      },
    }),
  ];
}

