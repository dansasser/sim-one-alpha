import { createHash } from 'node:crypto';
import { defineTool, type ToolDefinition } from '@flue/runtime';
import * as v from 'valibot';
import {
  createInMemoryCodingApprovalService,
  type CodingApprovalService,
} from '../approvals/approval-service.js';
import type {
  CodingApprovalActionType,
  CodingApprovalMetadata,
  CodingApprovalRequest,
} from '../approvals/approval-types.js';
import type { CodingProgressReporter } from '../events/progress-reporter.js';
import {
  createFlueLocalCodingSandbox,
  type CodingSandboxRuntime,
} from '../tools/sandbox-runtime.js';
import { evaluateGitApproval } from '../tools/coding-git-tools.js';
import { evaluateRepoApproval } from '../tools/coding-repo-workflow-tools.js';
import type { CodingWorkspaceTargetInput } from '../repo/workspace-target.js';
import type { CodingGithubAction, CodingGithubResult } from '../../../schemas/coding-worker.js';
import type {
  GitHubClient,
  GithubCheckSummary,
  GithubPullRequestSummary,
} from './github-client.js';

export interface CodingGitHubToolsOptions extends CodingWorkspaceTargetInput {
  client?: GitHubClient;
  approvalService?: CodingApprovalService;
  reporter?: CodingProgressReporter;
  sandbox?: CodingSandboxRuntime;
}

export function createCodingGitHubTools(input?: GitHubClient | CodingGitHubToolsOptions): ToolDefinition[] {
  const options = normalizeGitHubToolOptions(input);
  const approvalService = options.approvalService ?? createInMemoryCodingApprovalService();
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
          env: undefined,
          sessionId: 'coding-github-tools',
        });
    return sandboxPromise;
  };
  const getCwd = async () => {
    if (options.repoPath) {
      return options.repoPath;
    }
    if (options.workspaceRoot) {
      return (await getSandbox()).repoPath ?? options.workspaceRoot;
    }
    return undefined;
  };

  return [
    defineTool({
      name: 'coding_github_read_context',
      description:
        'Read GitHub issue, pull request, and check context for a coding-worker task. This is a read-only GitHub capability.',
      parameters: v.object({
        taskId: v.optional(v.string()),
        owner: v.string(),
        repo: v.string(),
        issueNumber: v.optional(v.number()),
        pullRequestNumber: v.optional(v.number()),
      }),
      execute: async (args) => withGithubToolProgress(options, readString(args.taskId) ?? 'unknown', 'read_context', 'Read GitHub context', async () => {
        const client = options.client;
        if (!client) {
          return toGithubResult({
            action: 'read_context',
            payload: {
              available: false,
              summary: 'No GitHub client is attached to this worker run.',
            },
          });
        }

        const payload: Record<string, unknown> = { available: true, owner: args.owner, repo: args.repo };
        try {
          if (typeof args.issueNumber === 'number') {
            payload.issue = await client.getIssue(args.owner, args.repo, args.issueNumber);
          }
          if (typeof args.pullRequestNumber === 'number') {
            payload.pullRequest = await client.getPullRequest(args.owner, args.repo, args.pullRequestNumber);
            payload.checks = await client.listPullRequestChecks(args.owner, args.repo, args.pullRequestNumber);
            payload.comments = client.listPullRequestComments
              ? await client.listPullRequestComments(args.owner, args.repo, args.pullRequestNumber)
              : [];
            payload.reviewThreads = client.listPullRequestReviewThreads
              ? await client.listPullRequestReviewThreads(args.owner, args.repo, args.pullRequestNumber)
              : [];
          }
        } catch (error) {
          return toGithubResult({
            action: 'read_context',
            payload: {
              available: false,
              summary: 'GitHub context is unavailable for this worker run.',
              error: formatToolError(error),
            },
          });
        }
        return toGithubResult({ action: 'read_context', payload });
      }),
    }),
    defineTool({
      name: 'coding_github_verify_pr',
      description:
        'Read and verify GitHub PR base, head, draft status, and optionally checks for a coding-worker task.',
      parameters: v.object({
        taskId: v.optional(v.string()),
        owner: v.string(),
        repo: v.string(),
        pullRequestNumber: v.number(),
        expectedBase: v.optional(v.string()),
        expectedHead: v.optional(v.string()),
        expectedDraft: v.optional(v.boolean()),
        requireChecksPassed: v.optional(v.boolean()),
      }),
      execute: async (args) => withGithubToolProgress(options, readString(args.taskId) ?? 'unknown', 'verify_pr', 'Verify GitHub PR', async () => {
        const client = options.client;
        if (!client) {
          return toGithubResult({
            action: 'verify_pr',
            payload: {
              available: false,
              verified: false,
              summary: 'No GitHub client is attached to this worker run.',
            },
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
          return toGithubResult({
            action: 'verify_pr',
            payload: {
              available: true,
              verified: mismatches.length === 0,
              owner: args.owner,
              repo: args.repo,
              pullRequestNumber: args.pullRequestNumber,
              pullRequest,
              checks,
              mismatches,
            },
          });
        } catch (error) {
          return toGithubResult({
            action: 'verify_pr',
            payload: {
              available: false,
              verified: false,
              summary: 'GitHub PR verification is unavailable for this worker run.',
              error: formatToolError(error),
            },
          });
        }
      }),
    }),
    defineTool({
      name: 'coding_github_list_issues',
      description: 'List GitHub issues for a repository. Read-only.',
      parameters: v.object({
        taskId: v.optional(v.string()),
        owner: v.string(),
        repo: v.string(),
        state: v.optional(v.string()),
      }),
      execute: async (args) => withGithubToolProgress(options, readString(args.taskId) ?? 'unknown', 'list_issues', 'List GitHub issues', async () => {
        const client = options.client;
        if (!client?.listIssues) {
          return toGithubResult({
            action: 'list_issues',
            payload: {
              available: false,
              summary: 'No GitHub list-issues client is attached to this worker run.',
            },
          });
        }
        try {
          const issues = await client.listIssues(args.owner, args.repo, readString(args.state));
          return toGithubResult({
            action: 'list_issues',
            payload: {
              owner: args.owner,
              repo: args.repo,
              state: readString(args.state),
              issues,
            },
          });
        } catch (error) {
          return toGithubResult({
            action: 'list_issues',
            payload: {
              available: false,
              summary: 'GitHub issue list is unavailable.',
              error: formatToolError(error),
            },
          });
        }
      }),
    }),
    defineTool({
      name: 'coding_github_list_prs',
      description: 'List GitHub pull requests for a repository. Read-only.',
      parameters: v.object({
        taskId: v.optional(v.string()),
        owner: v.string(),
        repo: v.string(),
        state: v.optional(v.string()),
      }),
      execute: async (args) => withGithubToolProgress(options, readString(args.taskId) ?? 'unknown', 'list_prs', 'List GitHub PRs', async () => {
        const client = options.client;
        if (!client?.listPullRequests) {
          return toGithubResult({
            action: 'list_prs',
            payload: {
              available: false,
              summary: 'No GitHub list-PRs client is attached to this worker run.',
            },
          });
        }
        try {
          const pullRequests = await client.listPullRequests(args.owner, args.repo, readString(args.state));
          return toGithubResult({
            action: 'list_prs',
            payload: {
              owner: args.owner,
              repo: args.repo,
              state: readString(args.state),
              pullRequests,
            },
          });
        } catch (error) {
          return toGithubResult({
            action: 'list_prs',
            payload: {
              available: false,
              summary: 'GitHub PR list is unavailable.',
              error: formatToolError(error),
            },
          });
        }
      }),
    }),
    defineTool({
      name: 'coding_github_branch_from_pr',
      description:
        'Approval-gated local branch creation from a GitHub pull request head through gh CLI. Requires approval for `${taskId}:repo.branch.create`.',
      parameters: v.object({
        taskId: v.optional(v.string()),
        owner: v.string(),
        repo: v.string(),
        pullRequestNumber: v.number(),
        branchName: v.string(),
      }),
      execute: async (args) => {
        const taskId = readString(args.taskId) ?? 'unknown';
        return withGithubToolProgress(options, taskId, 'branch_from_pr', 'Create branch from PR', async () => {
          if (!options.client?.createBranchFromPullRequest) {
            return toGithubResult({
              action: 'branch_from_pr',
              payload: unavailableWriteTool(),
            });
          }
          const branchPayload = {
            owner: args.owner,
            repo: args.repo,
            pullRequestNumber: args.pullRequestNumber,
            branchName: requireString(args.branchName, 'branchName'),
          };
          const approval = await evaluateRepoApproval(approvalService, options, {
            taskId,
            actionType: 'repo.branch.create',
            summary: `Create branch ${branchPayload.branchName} from PR #${branchPayload.pullRequestNumber} (${hashApprovalPayload(branchPayload)})`,
            reason: 'Checking out a PR branch mutates local repository state.',
            risk: 'This creates a local branch and may fetch from the remote.',
            target: `${args.owner}/${args.repo}#${args.pullRequestNumber}`,
          });
          if (!approval.evaluation.allowed) {
            emitGithubToolApprovalRequested(
              options,
              taskId,
              'branch_from_pr',
              'Create branch from PR requires approval.',
              approval.request,
              approval.evaluation.reason,
            );
            return toGithubResult({
              action: 'branch_from_pr',
              payload: { blocked: true, ...approval },
            });
          }
          const cwd = await getCwd();
          const result = await options.client.createBranchFromPullRequest({ ...branchPayload, cwd });
          return toGithubResult({
            action: 'branch_from_pr',
            payload: {
              status: result.status,
              branchName: result.branchName,
              result,
            },
          });
        });
      },
    }),
    defineTool({
      name: 'coding_github_review_comment',
      description:
        'Approval-gated line-specific GitHub PR review comment creation. Requires approval for `${taskId}:github.review_comment`.',
      parameters: v.object({
        taskId: v.optional(v.string()),
        owner: v.string(),
        repo: v.string(),
        pullRequestNumber: v.number(),
        body: v.string(),
        path: v.string(),
        line: v.number(),
        side: v.optional(v.string()),
        commitId: v.optional(v.string()),
        inReplyTo: v.optional(v.string()),
      }),
      execute: async (args) => {
        const taskId = readString(args.taskId) ?? 'unknown';
        return withGithubToolProgress(options, taskId, 'review_comment', 'Create review comment', async () => {
          if (!options.client?.createReviewComment) {
            return toGithubResult({
              action: 'review_comment',
              payload: unavailableWriteTool(),
            });
          }
          const commentPayload = {
            owner: args.owner,
            repo: args.repo,
            pullRequestNumber: args.pullRequestNumber,
            body: args.body,
            path: args.path,
            line: args.line,
            side: readString(args.side),
            commitId: readString(args.commitId),
            inReplyTo: readString(args.inReplyTo),
          };
          const approval = await evaluateGitApproval(options, {
            approvalService,
            taskId,
            actionType: 'github.review_comment',
            summary: `Review comment on ${args.path}:${args.line} for PR #${args.pullRequestNumber} (${hashApprovalPayload(commentPayload)})`,
            reason: 'Posting a line-specific review comment publishes remote GitHub review state.',
            risk: 'This may notify users and affect review context.',
            target: `${args.owner}/${args.repo}#${args.pullRequestNumber}`,
            metadata: {
              path: commentPayload.path,
              line: commentPayload.line,
              payloadHash: hashApprovalPayload(commentPayload),
            },
          });
          if (!approval.evaluation.allowed) {
            emitGithubToolApprovalRequested(
              options,
              taskId,
              'review_comment',
              'Create review comment requires approval.',
              approval.request,
              approval.evaluation.reason,
            );
            return toGithubResult({
              action: 'review_comment',
              payload: { blocked: true, ...approval },
            });
          }
          const cwd = await getCwd();
          const result = await options.client.createReviewComment({ ...commentPayload, cwd });
          return toGithubResult({
            action: 'review_comment',
            payload: {
              status: result.status,
              result,
            },
          });
        });
      },
    }),
    defineTool({
      name: 'coding_github_rerun_check',
      description:
        'Approval-gated GitHub Actions workflow-run rerun. Requires approval for `${taskId}:github.check.rerun`.',
      parameters: v.object({
        taskId: v.optional(v.string()),
        owner: v.string(),
        repo: v.string(),
        runId: v.string(),
        rerunFailedJobs: v.optional(v.boolean()),
      }),
      execute: async (args) => {
        const taskId = readString(args.taskId) ?? 'unknown';
        return withGithubToolProgress(options, taskId, 'rerun_check', 'Rerun GitHub check', async () => {
          if (!options.client?.rerunCheck) {
            return toGithubResult({
              action: 'rerun_check',
              payload: unavailableWriteTool(),
            });
          }
          const rerunPayload = {
            owner: args.owner,
            repo: args.repo,
            runId: requireString(args.runId, 'runId'),
            rerunFailedJobs: args.rerunFailedJobs === true,
          };
          const approval = await evaluateGitApproval(options, {
            approvalService,
            taskId,
            actionType: 'github.check.rerun',
            summary: `Rerun GitHub check run ${rerunPayload.runId} (${hashApprovalPayload(rerunPayload)})`,
            reason: 'Rerunning a check run mutates remote GitHub Actions state.',
            risk: 'This may re-execute CI jobs and consume runner minutes.',
            target: `${args.owner}/${args.repo}/actions/runs/${rerunPayload.runId}`,
            metadata: {
              runId: rerunPayload.runId,
              rerunFailedJobs: rerunPayload.rerunFailedJobs,
              payloadHash: hashApprovalPayload(rerunPayload),
            },
          });
          if (!approval.evaluation.allowed) {
            emitGithubToolApprovalRequested(
              options,
              taskId,
              'rerun_check',
              'Rerun GitHub check requires approval.',
              approval.request,
              approval.evaluation.reason,
            );
            return toGithubResult({
              action: 'rerun_check',
              payload: { blocked: true, ...approval },
            });
          }
          const cwd = await getCwd();
          const result = await options.client.rerunCheck({ ...rerunPayload, cwd });
          return toGithubResult({
            action: 'rerun_check',
            payload: {
              status: result.status,
              runId: result.runId,
              result,
            },
          });
        });
      },
    }),
    defineTool({
      name: 'coding_github_fork_repo',
      description:
        'Approval-gated GitHub repository fork creation. Requires approval for `${taskId}:github.fork_repo`.',
      parameters: v.object({
        taskId: v.optional(v.string()),
        owner: v.string(),
        repo: v.string(),
        defaultBranchOnly: v.optional(v.boolean()),
        clone: v.optional(v.boolean()),
        forkName: v.optional(v.string()),
      }),
      execute: async (args) => {
        const taskId = readString(args.taskId) ?? 'unknown';
        return withGithubToolProgress(options, taskId, 'fork_repo', 'Fork GitHub repository', async () => {
          if (!options.client?.forkRepository) {
            return toGithubResult({
              action: 'fork_repo',
              payload: unavailableWriteTool(),
            });
          }
          const forkPayload = {
            owner: args.owner,
            repo: args.repo,
            defaultBranchOnly: args.defaultBranchOnly === true,
            clone: args.clone,
            forkName: readString(args.forkName),
          };
          const approval = await evaluateGitApproval(options, {
            approvalService,
            taskId,
            actionType: 'github.fork_repo',
            summary: `Fork GitHub repository ${args.owner}/${args.repo} (${hashApprovalPayload(forkPayload)})`,
            reason: 'Forking creates a remote repository copy.',
            risk: 'This creates a new GitHub repository under the authenticated account.',
            target: `${args.owner}/${args.repo}`,
            metadata: {
              defaultBranchOnly: forkPayload.defaultBranchOnly,
              ...(forkPayload.forkName ? { forkName: forkPayload.forkName } : {}),
              payloadHash: hashApprovalPayload(forkPayload),
            },
          });
          if (!approval.evaluation.allowed) {
            emitGithubToolApprovalRequested(
              options,
              taskId,
              'fork_repo',
              'Fork GitHub repository requires approval.',
              approval.request,
              approval.evaluation.reason,
            );
            return toGithubResult({
              action: 'fork_repo',
              payload: { blocked: true, ...approval },
            });
          }
          const cwd = await getCwd();
          const result = await options.client.forkRepository({ ...forkPayload, cwd });
          return toGithubResult({
            action: 'fork_repo',
            payload: {
              status: result.status,
              forkName: result.forkName,
              result,
            },
          });
        });
      },
    }),
    defineTool({
      name: 'coding_github_request_approval',
      description:
        'Create an approval request for a GitHub, git, or repo side effect. This tool does not perform the side effect.',
      parameters: v.object({
        taskId: v.optional(v.string()),
        actionType: v.union([
          v.literal('git.commit'),
          v.literal('git.push'),
          v.literal('github.comment'),
          v.literal('github.pr.create'),
          v.literal('github.pr.update'),
          v.literal('github.pr.ready'),
          v.literal('github.issue.update'),
          v.literal('github.review-thread.update'),
          v.literal('repo.clone'),
          v.literal('repo.register'),
          v.literal('repo.branch.create'),
          v.literal('repo.worktree.create'),
          v.literal('repo.fetch'),
          v.literal('repo.sync'),
          v.literal('github.branch_from_pr'),
          v.literal('github.review_comment'),
          v.literal('github.check.rerun'),
          v.literal('github.fork_repo'),
        ]),
        summary: v.string(),
        reason: v.string(),
        risk: v.string(),
        target: v.optional(v.string()),
      }),
      execute: async (args) => {
        const taskId = readString(args.taskId) ?? 'unknown';
        return withGithubToolProgress(options, taskId, 'approve_request', 'Request approval', async () => {
          const request = await approvalService.createRequest({
            taskId,
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
          return toGithubResult({
            action: 'approve_request',
            payload: {
              request,
              evaluation,
            },
          });
        });
      },
    }),
    defineTool({
      name: 'coding_github_update_pr',
      description: 'Approval-gated GitHub PR metadata update through the configured GitHub client.',
      parameters: v.object({
        taskId: v.optional(v.string()),
        owner: v.string(),
        repo: v.string(),
        pullRequestNumber: v.number(),
        title: v.optional(v.string()),
        body: v.optional(v.string()),
        base: v.optional(v.string()),
      }),
      execute: async (args) => {
        const taskId = readString(args.taskId) ?? 'unknown';
        return withGithubToolProgress(options, taskId, 'update_pr', 'Update GitHub PR', async () => {
          if (!options.client?.updatePullRequest) {
            return toGithubResult({
              action: 'update_pr',
              payload: unavailableWriteTool(),
            });
          }
          const base = readString(args.base);
          const prUpdatePayload = {
            title: readString(args.title),
            body: readString(args.body),
            base,
          };
          const approval = await evaluateGitApproval(options, {
            approvalService,
            taskId,
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
            emitGithubToolApprovalRequested(
              options,
              taskId,
              'update_pr',
              'Update GitHub PR requires approval.',
              approval.request,
              approval.evaluation.reason,
            );
            return toGithubResult({
              action: 'update_pr',
              payload: { blocked: true, ...approval },
            });
          }
          const result = await options.client.updatePullRequest({
            owner: args.owner,
            repo: args.repo,
            pullRequestNumber: args.pullRequestNumber,
            title: readString(args.title),
            body: readString(args.body),
            ...(base ? { base } : {}),
          });
          return toGithubResult({
            action: 'update_pr',
            payload: {
              status: result.status,
              ...(base ? { base } : {}),
              result,
            },
          });
        });
      },
    }),
    defineTool({
      name: 'coding_github_set_pr_ready',
      description: 'Approval-gated GitHub PR ready/draft status update.',
      parameters: v.object({
        taskId: v.optional(v.string()),
        owner: v.string(),
        repo: v.string(),
        pullRequestNumber: v.number(),
        ready: v.boolean(),
      }),
      execute: async (args) => {
        const taskId = readString(args.taskId) ?? 'unknown';
        return withGithubToolProgress(options, taskId, 'ready_pr', 'Set PR ready/draft status', async () => {
          if (!options.client?.setPullRequestReady) {
            return toGithubResult({
              action: 'ready_pr',
              payload: unavailableWriteTool(),
            });
          }
          const readyPayload = { ready: args.ready };
          const approval = await evaluateGitApproval(options, {
            approvalService,
            taskId,
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
            emitGithubToolApprovalRequested(
              options,
              taskId,
              'ready_pr',
              'Set PR ready/draft status requires approval.',
              approval.request,
              approval.evaluation.reason,
            );
            return toGithubResult({
              action: 'ready_pr',
              payload: { blocked: true, ...approval },
            });
          }
          const result = await options.client.setPullRequestReady({
            owner: args.owner,
            repo: args.repo,
            pullRequestNumber: args.pullRequestNumber,
            ready: args.ready,
          });
          return toGithubResult({
            action: 'ready_pr',
            payload: {
              status: result.status,
              ready: args.ready,
              result,
            },
          });
        });
      },
    }),
    defineTool({
      name: 'coding_github_comment_pr',
      description: 'Approval-gated GitHub PR comment creation.',
      parameters: v.object({
        taskId: v.optional(v.string()),
        owner: v.string(),
        repo: v.string(),
        pullRequestNumber: v.number(),
        body: v.string(),
      }),
      execute: async (args) => {
        const taskId = readString(args.taskId) ?? 'unknown';
        return withGithubToolProgress(options, taskId, 'comment', 'Comment on GitHub PR', async () => {
          if (!options.client?.commentOnPullRequest) {
            return toGithubResult({
              action: 'comment',
              payload: unavailableWriteTool(),
            });
          }
          const commentPayload = { body: args.body };
          const approval = await evaluateGitApproval(options, {
            approvalService,
            taskId,
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
            emitGithubToolApprovalRequested(
              options,
              taskId,
              'comment',
              'Comment on GitHub PR requires approval.',
              approval.request,
              approval.evaluation.reason,
            );
            return toGithubResult({
              action: 'comment',
              payload: { blocked: true, ...approval },
            });
          }
          const result = await options.client.commentOnPullRequest({
            owner: args.owner,
            repo: args.repo,
            pullRequestNumber: args.pullRequestNumber,
            body: args.body,
          });
          return toGithubResult({
            action: 'comment',
            payload: {
              status: result.status,
              result,
            },
          });
        });
      },
    }),
    defineTool({
      name: 'coding_github_update_issue',
      description: 'Approval-gated GitHub issue metadata update.',
      parameters: v.object({
        taskId: v.optional(v.string()),
        owner: v.string(),
        repo: v.string(),
        issueNumber: v.number(),
        title: v.optional(v.string()),
        body: v.optional(v.string()),
      }),
      execute: async (args) => {
        const taskId = readString(args.taskId) ?? 'unknown';
        return withGithubToolProgress(options, taskId, 'update_issue', 'Update GitHub issue', async () => {
          if (!options.client?.updateIssue) {
            return toGithubResult({
              action: 'update_issue',
              payload: unavailableWriteTool(),
            });
          }
          const issuePayload = {
            title: readString(args.title),
            body: readString(args.body),
          };
          const approval = await evaluateGitApproval(options, {
            approvalService,
            taskId,
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
            emitGithubToolApprovalRequested(
              options,
              taskId,
              'update_issue',
              'Update GitHub issue requires approval.',
              approval.request,
              approval.evaluation.reason,
            );
            return toGithubResult({
              action: 'update_issue',
              payload: { blocked: true, ...approval },
            });
          }
          const result = await options.client.updateIssue({
            owner: args.owner,
            repo: args.repo,
            issueNumber: args.issueNumber,
            title: readString(args.title),
            body: readString(args.body),
          });
          return toGithubResult({
            action: 'update_issue',
            payload: {
              status: result.status,
              result,
            },
          });
        });
      },
    }),
    defineTool({
      name: 'coding_github_update_review_thread',
      description: 'Approval-gated GitHub PR review-thread reply or resolution update.',
      parameters: v.object({
        taskId: v.optional(v.string()),
        threadId: v.string(),
        replyBody: v.optional(v.string()),
        resolve: v.optional(v.boolean()),
      }),
      execute: async (args) => {
        const taskId = readString(args.taskId) ?? 'unknown';
        return withGithubToolProgress(options, taskId, 'update_review_thread', 'Update GitHub review thread', async () => {
          if (!options.client?.updateReviewThread) {
            return toGithubResult({
              action: 'update_review_thread',
              payload: unavailableWriteTool(),
            });
          }
          const threadPayload = {
            replyBody: readString(args.replyBody),
            resolve: typeof args.resolve === 'boolean' ? args.resolve : undefined,
          };
          const approval = await evaluateGitApproval(options, {
            approvalService,
            taskId,
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
            emitGithubToolApprovalRequested(
              options,
              taskId,
              'update_review_thread',
              'Update GitHub review thread requires approval.',
              approval.request,
              approval.evaluation.reason,
            );
            return toGithubResult({
              action: 'update_review_thread',
              payload: { blocked: true, ...approval },
            });
          }
          const result = await options.client.updateReviewThread({
            threadId: args.threadId,
            replyBody: readString(args.replyBody),
            resolve: typeof args.resolve === 'boolean' ? args.resolve : undefined,
          });
          return toGithubResult({
            action: 'update_review_thread',
            payload: {
              status: result.status,
              id: args.threadId,
              result,
            },
          });
        });
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

function emitGithubToolStarted(
  options: CodingGitHubToolsOptions,
  taskId: string | undefined,
  action: CodingGithubAction['action'],
  summary: string,
): void {
  if (!taskId || !options.reporter) {
    return;
  }
  options.reporter.emit({
    type: 'coding.github.started',
    taskId,
    action,
    summary,
  });
}

function emitGithubToolApprovalRequested(
  options: CodingGitHubToolsOptions,
  taskId: string | undefined,
  action: CodingGithubAction['action'],
  summary: string,
  request: CodingApprovalRequest,
  reason: string,
): void {
  if (!taskId || !options.reporter) {
    return;
  }
  options.reporter.emit({
    type: 'coding.github.approval_requested',
    taskId,
    action,
    summary,
    decision: reason,
    evidence: [request.id],
  });
}

function emitGithubToolCompleted(
  options: CodingGitHubToolsOptions,
  taskId: string | undefined,
  action: CodingGithubAction['action'],
  summary: string,
): void {
  if (!taskId || !options.reporter) {
    return;
  }
  options.reporter.emit({
    type: 'coding.github.completed',
    taskId,
    action,
    summary,
  });
}

function emitGithubToolFailed(
  options: CodingGitHubToolsOptions,
  taskId: string | undefined,
  action: CodingGithubAction['action'],
  error: unknown,
): void {
  if (!taskId || !options.reporter) {
    return;
  }
  options.reporter.emit({
    type: 'coding.github.action_completed',
    taskId,
    action,
    summary: error instanceof Error ? error.message : String(error),
    status: 'failed',
  });
}

async function withGithubToolProgress<T extends string>(
  options: CodingGitHubToolsOptions,
  taskId: string | undefined,
  action: CodingGithubAction['action'],
  summary: string,
  operation: () => Promise<T>,
): Promise<T> {
  emitGithubToolStarted(options, taskId, action, summary);
  try {
    const result = await operation();
    if (!isBlockedGithubResult(result)) {
      emitGithubToolCompleted(options, taskId, action, `${summary} completed.`);
    }
    return result;
  } catch (error) {
    emitGithubToolFailed(options, taskId, action, error);
    throw error;
  }
}

function isBlockedGithubResult(result: string): boolean {
  try {
    const parsed = JSON.parse(result) as CodingGithubResult;
    return parsed.actions.some(
      (action) =>
        action.payload != null &&
        typeof action.payload === 'object' &&
        'blocked' in action.payload &&
        action.payload.blocked === true,
    );
  } catch {
    return false;
  }
}

function hashApprovalPayload(payload: Record<string, unknown>): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(payload, Object.keys(payload).sort()))
    .digest('hex')
    .slice(0, 12);
  return digest;
}

function unavailableWriteTool(): Record<string, unknown> {
  return {
    available: false,
    blocked: true,
    summary: 'No GitHub write client is attached to this worker run.',
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function toGithubResult(action: CodingGithubAction): string {
  const result: CodingGithubResult = { actions: [action] };
  return JSON.stringify(result);
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
