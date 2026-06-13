export interface GithubIssueSummary {
  number: number;
  title: string;
  state: string;
  url?: string;
}

export interface GithubPullRequestSummary extends GithubIssueSummary {
  headRef?: string;
  baseRef?: string;
}

export interface GithubCheckSummary {
  name: string;
  status: string;
  conclusion?: string;
  detailsUrl?: string;
}

export interface GitHubClient {
  getIssue(owner: string, repo: string, issueNumber: number): Promise<GithubIssueSummary>;
  getPullRequest(owner: string, repo: string, pullRequestNumber: number): Promise<GithubPullRequestSummary>;
  listPullRequestChecks(owner: string, repo: string, pullRequestNumber: number): Promise<GithubCheckSummary[]>;
}

