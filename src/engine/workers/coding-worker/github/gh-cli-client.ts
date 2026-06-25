import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  GitHubClient,
  GithubCheckSummary,
  GithubCommentSummary,
  GithubIssueSummary,
  GithubPullRequestSummary,
  GithubReviewThreadSummary,
  GithubWriteSummary,
} from '../../../../engine/workers/coding-worker/github/github-client.js';

const execFileAsync = promisify(execFile);

type GhJsonRunner = (
  args: string[],
  env: Record<string, string | undefined> | undefined,
  cwd?: string,
) => Promise<unknown>;

export class GhCliGitHubClient implements GitHubClient {
  constructor(
    private readonly env?: Record<string, string | undefined>,
    private readonly cwd?: string,
    private readonly ghJsonRunner: GhJsonRunner = runGhJson,
  ) {}

  async getDefaultBranch(owner: string, repo: string): Promise<string> {
    validateOwnerRepo(owner, repo);
    const data = await this.ghJsonRunner(
      ['repo', 'view', `${owner}/${repo}`, '--json', 'defaultBranchRef'],
      this.env,
      this.cwd,
    );
    const defaultBranch = (data as { defaultBranchRef?: { name?: string } } | undefined)?.defaultBranchRef?.name;
    if (typeof defaultBranch !== 'string' || defaultBranch.length === 0) {
      return 'main';
    }
    return defaultBranch;
  }

  async getIssue(owner: string, repo: string, issueNumber: number): Promise<GithubIssueSummary> {
    validateOwnerRepo(owner, repo);
    validatePositiveInteger('issueNumber', issueNumber);
    const data = await this.ghJsonRunner(
      ['issue', 'view', String(issueNumber), '--repo', `${owner}/${repo}`, '--json', 'number,title,state,url'],
      this.env,
      this.cwd,
    );
    return data as GithubIssueSummary;
  }

  async listIssues(owner: string, repo: string, state?: string): Promise<GithubIssueSummary[]> {
    validateOwnerRepo(owner, repo);
    const args = ['issue', 'list', '--repo', `${owner}/${repo}`, '--json', 'number,title,state,url', '--limit', '100'];
    if (state) {
      args.push('--state', state);
    }
    const data = await this.ghJsonRunner(args, this.env, this.cwd);
    return Array.isArray(data) ? data.map(normalizeGhIssueSummary) : [];
  }

  async getPullRequest(owner: string, repo: string, pullRequestNumber: number): Promise<GithubPullRequestSummary> {
    validateOwnerRepo(owner, repo);
    validatePositiveInteger('pullRequestNumber', pullRequestNumber);
    const data = await this.ghJsonRunner(
      [
        'pr',
        'view',
        String(pullRequestNumber),
        '--repo',
        `${owner}/${repo}`,
        '--json',
        'number,title,state,url,headRefName,baseRefName,isDraft',
      ],
      this.env,
      this.cwd,
    );
    const pr = data as GithubPullRequestSummary & { headRefName?: string; baseRefName?: string };
    return {
      ...pr,
      headRef: pr.headRef ?? pr.headRefName,
      baseRef: pr.baseRef ?? pr.baseRefName,
    };
  }

  async listPullRequests(owner: string, repo: string, state?: string): Promise<GithubPullRequestSummary[]> {
    validateOwnerRepo(owner, repo);
    const args = [
      'pr',
      'list',
      '--repo',
      `${owner}/${repo}`,
      '--json',
      'number,title,state,url,headRefName,baseRefName,isDraft',
      '--limit',
      '100',
    ];
    if (state) {
      args.push('--state', state);
    }
    const data = await this.ghJsonRunner(args, this.env, this.cwd);
    return Array.isArray(data)
      ? data.map((item) => {
          const pr = item as GithubPullRequestSummary & { headRefName?: string; baseRefName?: string };
          return {
            ...pr,
            headRef: pr.headRef ?? pr.headRefName,
            baseRef: pr.baseRef ?? pr.baseRefName,
          };
        })
      : [];
  }

  async listPullRequestChecks(owner: string, repo: string, pullRequestNumber: number): Promise<GithubCheckSummary[]> {
    validateOwnerRepo(owner, repo);
    validatePositiveInteger('pullRequestNumber', pullRequestNumber);
    const data = await this.ghJsonRunner(
      [
        'pr',
        'checks',
        String(pullRequestNumber),
        '--repo',
        `${owner}/${repo}`,
        '--json',
        'name,state,bucket,link',
      ],
      this.env,
      this.cwd,
    );
    return Array.isArray(data) ? data.map(normalizeGhPrCheckSummary) : [];
  }

  async listPullRequestComments(owner: string, repo: string, pullRequestNumber: number): Promise<GithubCommentSummary[]> {
    validateOwnerRepo(owner, repo);
    validatePositiveInteger('pullRequestNumber', pullRequestNumber);
    const data = await this.ghJsonRunner(
      [
        'pr',
        'view',
        String(pullRequestNumber),
        '--repo',
        `${owner}/${repo}`,
        '--json',
        'comments',
      ],
      this.env,
      this.cwd,
    );
    const comments = (data as { comments?: unknown }).comments;
    if (!Array.isArray(comments)) {
      return [];
    }
    return comments
      .map((comment) => normalizeComment(comment))
      .filter((comment): comment is GithubCommentSummary => Boolean(comment));
  }

  async listPullRequestReviewThreads(
    owner: string,
    repo: string,
    pullRequestNumber: number,
  ): Promise<GithubReviewThreadSummary[]> {
    validateOwnerRepo(owner, repo);
    validatePositiveInteger('pullRequestNumber', pullRequestNumber);
    const data = await this.ghJsonRunner(
      [
        'api',
        'graphql',
        '-f',
        `query=${reviewThreadsQuery}`,
        '-F',
        `owner=${owner}`,
        '-F',
        `repo=${repo}`,
        '-F',
        `number=${pullRequestNumber}`,
      ],
      this.env,
      this.cwd,
    );
    const threads =
      (data as {
        data?: {
          repository?: {
            pullRequest?: {
              reviewThreads?: {
                nodes?: unknown[];
              };
            };
          };
        };
      }).data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
    return threads
      .map((thread) => normalizeReviewThread(thread))
      .filter((thread): thread is GithubReviewThreadSummary => Boolean(thread));
  }

  async createBranchFromPullRequest(input: {
    owner: string;
    repo: string;
    pullRequestNumber: number;
    branchName: string;
    cwd?: string;
  }): Promise<GithubWriteSummary> {
    validateOwnerRepo(input.owner, input.repo);
    validatePositiveInteger('pullRequestNumber', input.pullRequestNumber);
    validateGhPathSegment('branchName', input.branchName);
    const stdout = await runGh(
      [
        'pr',
        'checkout',
        String(input.pullRequestNumber),
        '--repo',
        `${input.owner}/${input.repo}`,
        '--branch',
        input.branchName,
      ],
      this.env,
      input.cwd ?? this.cwd,
    );
    return {
      status: 'created',
      branchName: input.branchName,
      stdout,
    };
  }

  async createReviewComment(input: {
    owner: string;
    repo: string;
    pullRequestNumber: number;
    body: string;
    path: string;
    line: number;
    side?: string;
    commitId?: string;
    inReplyTo?: string;
    cwd?: string;
  }): Promise<GithubWriteSummary> {
    validateOwnerRepo(input.owner, input.repo);
    validatePositiveInteger('pullRequestNumber', input.pullRequestNumber);
    if (!input.body.trim()) {
      throw new Error('Review comment body is required.');
    }
    if (!input.path.trim()) {
      throw new Error('Review comment path is required.');
    }
    if (!Number.isInteger(input.line) || input.line <= 0) {
      throw new Error(`Invalid review comment line: ${input.line}`);
    }
    const commitId = input.commitId ?? (await this.resolvePullRequestHeadSha(input.owner, input.repo, input.pullRequestNumber));
    const fields: string[] = [
      '-f',
      `body=${input.body}`,
      '-f',
      `path=${input.path}`,
      '-f',
      `line=${input.line}`,
      '-f',
      `commit_id=${commitId}`,
    ];
    if (input.side) {
      fields.push('-f', `side=${input.side}`);
    }
    if (input.inReplyTo) {
      fields.push('-f', `in_reply_to=${input.inReplyTo}`);
    }
    const stdout = await runGh(
      [
        'api',
        '--method',
        'POST',
        `-H`,
        'Accept: application/vnd.github+json',
        `repos/${input.owner}/${input.repo}/pulls/${input.pullRequestNumber}/comments`,
        ...fields,
      ],
      this.env,
      input.cwd ?? this.cwd,
    );
    return writeSummary('created', stdout);
  }

  async rerunCheck(input: {
    owner: string;
    repo: string;
    runId: string;
    rerunFailedJobs?: boolean;
    cwd?: string;
  }): Promise<GithubWriteSummary> {
    validateOwnerRepo(input.owner, input.repo);
    validateGhPathSegment('runId', input.runId);
    const args = ['run', 'rerun', input.runId, '--repo', `${input.owner}/${input.repo}`];
    if (input.rerunFailedJobs) {
      args.push('--failed');
    }
    const stdout = await runGh(args, this.env, input.cwd ?? this.cwd);
    return {
      status: 'rerun',
      runId: input.runId,
      stdout,
    };
  }

  async forkRepository(input: {
    owner: string;
    repo: string;
    defaultBranchOnly?: boolean;
    clone?: boolean;
    forkName?: string;
    cwd?: string;
  }): Promise<GithubWriteSummary> {
    validateOwnerRepo(input.owner, input.repo);
    const args = ['repo', 'fork', `${input.owner}/${input.repo}`];
    if (input.defaultBranchOnly) {
      args.push('--default-branch-only');
    }
    if (input.clone === false) {
      args.push('--remote');
    }
    if (input.forkName) {
      args.push('--fork-name', input.forkName);
    }
    const stdout = await runGh(args, this.env, input.cwd ?? this.cwd);
    const result: { status: 'forked'; stdout: string; forkName?: string } = {
      status: 'forked',
      stdout,
    };
    if (input.forkName) {
      result.forkName = input.forkName;
    }
    return result;
  }

  async updatePullRequest(input: {
    owner: string;
    repo: string;
    pullRequestNumber: number;
    title?: string;
    body?: string;
    base?: string;
  }): Promise<GithubWriteSummary> {
    validateOwnerRepo(input.owner, input.repo);
    validatePositiveInteger('pullRequestNumber', input.pullRequestNumber);
    const args = ['pr', 'edit', String(input.pullRequestNumber), '--repo', `${input.owner}/${input.repo}`];
    if (input.title) {
      args.push('--title', input.title);
    }
    if (input.body) {
      args.push('--body', input.body);
    }
    if (input.base) {
      args.push('--base', input.base);
    }
    return writeSummary('updated', await runGh(args, this.env, this.cwd));
  }

  async setPullRequestReady(input: {
    owner: string;
    repo: string;
    pullRequestNumber: number;
    ready: boolean;
  }): Promise<GithubWriteSummary> {
    validateOwnerRepo(input.owner, input.repo);
    validatePositiveInteger('pullRequestNumber', input.pullRequestNumber);
    const args = ['pr', 'ready', String(input.pullRequestNumber), '--repo', `${input.owner}/${input.repo}`];
    if (!input.ready) {
      args.push('--undo');
    }
    return writeSummary(input.ready ? 'ready' : 'draft', await runGh(args, this.env, this.cwd));
  }

  async commentOnPullRequest(input: {
    owner: string;
    repo: string;
    pullRequestNumber: number;
    body: string;
  }): Promise<GithubWriteSummary> {
    validateOwnerRepo(input.owner, input.repo);
    validatePositiveInteger('pullRequestNumber', input.pullRequestNumber);
    if (!input.body.trim()) {
      throw new Error('GitHub PR comment body is required.');
    }
    return writeSummary(
      'commented',
      await runGh(
        [
          'pr',
          'comment',
          String(input.pullRequestNumber),
          '--repo',
          `${input.owner}/${input.repo}`,
          '--body',
          input.body,
        ],
        this.env,
        this.cwd,
      ),
    );
  }

  async updateIssue(input: {
    owner: string;
    repo: string;
    issueNumber: number;
    title?: string;
    body?: string;
  }): Promise<GithubWriteSummary> {
    validateOwnerRepo(input.owner, input.repo);
    validatePositiveInteger('issueNumber', input.issueNumber);
    const args = ['issue', 'edit', String(input.issueNumber), '--repo', `${input.owner}/${input.repo}`];
    if (input.title) {
      args.push('--title', input.title);
    }
    if (input.body) {
      args.push('--body', input.body);
    }
    return writeSummary('updated', await runGh(args, this.env, this.cwd));
  }

  async updateReviewThread(input: {
    threadId: string;
    replyBody?: string;
    resolve?: boolean;
  }): Promise<GithubWriteSummary> {
    validateGhPathSegment('threadId', input.threadId);
    if (!input.replyBody && input.resolve === undefined) {
      throw new Error('Review thread update requires replyBody or resolve.');
    }
    let stdout = '';
    if (input.replyBody) {
      stdout += await runGh(
        [
          'api',
          'graphql',
          '-f',
          `query=${reviewThreadReplyMutation}`,
          '-F',
          `threadId=${input.threadId}`,
          '-F',
          `body=${input.replyBody}`,
        ],
        this.env,
        this.cwd,
      );
    }
    if (input.resolve !== undefined) {
      stdout += await runGh(
        [
          'api',
          'graphql',
          '-f',
          `query=${input.resolve ? resolveReviewThreadMutation : unresolveReviewThreadMutation}`,
          '-F',
          `threadId=${input.threadId}`,
        ],
        this.env,
        this.cwd,
      );
    }
    return {
      status: 'updated',
      id: input.threadId,
      stdout,
    };
  }

  private async resolvePullRequestHeadSha(owner: string, repo: string, pullRequestNumber: number): Promise<string> {
    const data = await this.ghJsonRunner(
      ['pr', 'view', String(pullRequestNumber), '--repo', `${owner}/${repo}`, '--json', 'headRefOid'],
      this.env,
      this.cwd,
    );
    const sha = (data as { headRefOid?: string } | undefined)?.headRefOid;
    if (typeof sha !== 'string' || sha.length === 0) {
      throw new Error(`Could not resolve head SHA for PR #${pullRequestNumber}`);
    }
    return sha;
  }
}

export function createDefaultGitHubClient(
  env?: Record<string, string | undefined>,
  cwd?: string,
): GitHubClient {
  return new GhCliGitHubClient(env, cwd);
}

function normalizeGhIssueSummary(value: unknown): GithubIssueSummary {
  const issue = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const number = typeof issue.number === 'number' ? issue.number : 0;
  return {
    number,
    title: readString(issue.title) ?? 'unknown',
    state: readString(issue.state) ?? 'unknown',
    url: readString(issue.url),
  };
}

function normalizeGhPrCheckSummary(value: unknown): GithubCheckSummary {
  const check = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    name: readString(check.name) ?? 'unknown',
    status: readString(check.state) ?? readString(check.bucket) ?? 'unknown',
    conclusion: readString(check.bucket),
    detailsUrl: readString(check.link),
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

async function runGhJson(
  args: string[],
  env: Record<string, string | undefined> | undefined,
  cwd?: string,
): Promise<unknown> {
  const stdout = await runGh(args, env, cwd);
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`GitHub CLI failed: ${formatGhError(error)} stdout=${stdout}`);
  }
}

async function runGh(
  args: string[],
  env: Record<string, string | undefined> | undefined,
  cwd?: string,
): Promise<string> {
  try {
    const result = await execFileAsync('gh', args, {
      env: createGhEnv(env),
      cwd,
      windowsHide: true,
      timeout: 30_000,
    });
    return result.stdout;
  } catch (error) {
    throw new Error(`GitHub CLI failed: ${formatGhError(error)}`);
  }
}

function createGhEnv(env: Record<string, string | undefined> | undefined): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'SystemRoot', 'ComSpec'] as const) {
    const value = process.env[key];
    if (typeof value === 'string' && value.length > 0) {
      merged[key] = value;
    }
  }
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN'] as const) {
    const value = env?.[key] ?? process.env[key];
    if (typeof value === 'string' && value.length > 0) {
      merged[key] = value;
    }
  }
  return merged;
}

function validateOwnerRepo(owner: string, repo: string): void {
  validateGhPathSegment('owner', owner);
  validateGhPathSegment('repo', repo);
}

function validateGhPathSegment(name: string, value: string): void {
  if (!value || /\s/.test(value) || value.startsWith('-')) {
    throw new Error(`Invalid GitHub ${name}: ${value}`);
  }
}

function validatePositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid GitHub ${name}: ${value}`);
  }
}

function formatGhError(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return String(error);
  }
  const candidate = error as {
    message?: string;
    stdout?: string;
    stderr?: string;
  };
  const details = [candidate.message, candidate.stderr, candidate.stdout]
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())
    .join(' ');
  return details || String(error);
}

function normalizeComment(value: unknown): GithubCommentSummary | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const comment = value as {
    id?: unknown;
    body?: unknown;
    author?: { login?: unknown } | unknown;
    createdAt?: unknown;
    updatedAt?: unknown;
  };
  if (typeof comment.id !== 'string' || typeof comment.body !== 'string') {
    return undefined;
  }
  const author =
    comment.author && typeof comment.author === 'object'
      ? (comment.author as { login?: unknown }).login
      : undefined;
  return {
    id: comment.id,
    body: comment.body,
    ...(typeof author === 'string' ? { author } : {}),
    ...(typeof comment.createdAt === 'string' ? { createdAt: comment.createdAt } : {}),
    ...(typeof comment.updatedAt === 'string' ? { updatedAt: comment.updatedAt } : {}),
  };
}

function normalizeReviewThread(value: unknown): GithubReviewThreadSummary | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const thread = value as {
    id?: unknown;
    isResolved?: unknown;
    isOutdated?: unknown;
    path?: unknown;
    line?: unknown;
    originalLine?: unknown;
    comments?: { nodes?: unknown[] };
  };
  if (typeof thread.id !== 'string') {
    return undefined;
  }
  return {
    id: thread.id,
    isResolved: thread.isResolved === true,
    isOutdated: thread.isOutdated === true,
    ...(typeof thread.path === 'string' ? { path: thread.path } : {}),
    ...(typeof thread.line === 'number' ? { line: thread.line } : {}),
    ...(typeof thread.originalLine === 'number' ? { originalLine: thread.originalLine } : {}),
    comments: (thread.comments?.nodes ?? [])
      .map((comment) => normalizeComment(comment))
      .filter((comment): comment is GithubCommentSummary => Boolean(comment)),
  };
}

function writeSummary(status: string, stdout: string): GithubWriteSummary {
  return { status, stdout };
}

// Note: reviewThreadsQuery caps pagination at first: 100 for both review threads and
// nested comments. Review threads or comment pages beyond 100 are not fetched.
const reviewThreadsQuery = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          originalLine
          comments(first: 100) {
            nodes {
              id
              body
              createdAt
              updatedAt
              author { login }
            }
          }
        }
      }
    }
  }
}`;

const reviewThreadReplyMutation = `
mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
    comment { id url }
  }
}`;

const resolveReviewThreadMutation = `
mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread { id isResolved }
  }
}`;

const unresolveReviewThreadMutation = `
mutation($threadId: ID!) {
  unresolveReviewThread(input: { threadId: $threadId }) {
    thread { id isResolved }
  }
}`;
