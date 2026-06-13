import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  GitHubClient,
  GithubCheckSummary,
  GithubIssueSummary,
  GithubPullRequestSummary,
} from './github-client.js';

const execFileAsync = promisify(execFile);

type GhJsonRunner = (
  args: string[],
  env: Record<string, string | undefined> | undefined,
) => Promise<unknown>;

export class GhCliGitHubClient implements GitHubClient {
  constructor(
    private readonly env?: Record<string, string | undefined>,
    private readonly ghJsonRunner: GhJsonRunner = runGhJson,
  ) {}

  async getIssue(owner: string, repo: string, issueNumber: number): Promise<GithubIssueSummary> {
    validateOwnerRepo(owner, repo);
    validatePositiveInteger('issueNumber', issueNumber);
    const data = await this.ghJsonRunner(
      ['issue', 'view', String(issueNumber), '--repo', `${owner}/${repo}`, '--json', 'number,title,state,url'],
      this.env,
    );
    return data as GithubIssueSummary;
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
        'number,title,state,url,headRefName,baseRefName',
      ],
      this.env,
    );
    const pr = data as GithubPullRequestSummary & { headRefName?: string; baseRefName?: string };
    return {
      ...pr,
      headRef: pr.headRef ?? pr.headRefName,
      baseRef: pr.baseRef ?? pr.baseRefName,
    };
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
    );
    return Array.isArray(data) ? data.map(normalizeGhPrCheckSummary) : [];
  }
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
): Promise<unknown> {
  try {
    const result = await execFileAsync('gh', args, {
      env: createGhEnv(env),
      windowsHide: true,
      timeout: 30_000,
    });
    return JSON.parse(result.stdout);
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
