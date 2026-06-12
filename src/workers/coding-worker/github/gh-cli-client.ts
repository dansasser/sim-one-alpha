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
    const data = await runGhJson(['issue', 'view', String(issueNumber), '--repo', `${owner}/${repo}`, '--json', 'number,title,state,url']);
    return data as GithubIssueSummary;
  }

  async getPullRequest(owner: string, repo: string, pullRequestNumber: number): Promise<GithubPullRequestSummary> {
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
  const result = await execFileAsync('gh', args, {
    windowsHide: true,
    timeout: 30_000,
  });
  return JSON.parse(result.stdout);
}

