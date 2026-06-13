import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  GitHubClient,
  GithubCheckSummary,
  GithubIssueSummary,
  GithubPullRequestSummary,
} from './github-client.js';

const execFileAsync = promisify(execFile);

export class GhCliGitHubClient implements GitHubClient {
  async getIssue(owner: string, repo: string, issueNumber: number): Promise<GithubIssueSummary> {
    validateOwnerRepo(owner, repo);
    validatePositiveInteger('issueNumber', issueNumber);
    const data = await runGhJson(['issue', 'view', String(issueNumber), '--repo', `${owner}/${repo}`, '--json', 'number,title,state,url']);
    return data as GithubIssueSummary;
  }

  async getPullRequest(owner: string, repo: string, pullRequestNumber: number): Promise<GithubPullRequestSummary> {
    validateOwnerRepo(owner, repo);
    validatePositiveInteger('pullRequestNumber', pullRequestNumber);
    const data = await runGhJson([
      'pr',
      'view',
      String(pullRequestNumber),
      '--repo',
      `${owner}/${repo}`,
      '--json',
      'number,title,state,url,headRefName,baseRefName',
    ]);
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
    const data = await runGhJson([
      'pr',
      'checks',
      String(pullRequestNumber),
      '--repo',
      `${owner}/${repo}`,
      '--json',
      'name,status,conclusion,detailsUrl',
    ]);
    return Array.isArray(data) ? (data as GithubCheckSummary[]) : [];
  }
}

async function runGhJson(args: string[]): Promise<unknown> {
  try {
    const result = await execFileAsync('gh', args, {
      windowsHide: true,
      timeout: 30_000,
    });
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`GitHub CLI failed: ${formatGhError(error)}`);
  }
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
