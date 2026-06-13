export interface GithubIssueSummary {
  number: number;
  title: string;
  state: string;
  url?: string;
}

export interface GithubPullRequestSummary extends GithubIssueSummary {
  headRef?: string;
  baseRef?: string;
  isDraft?: boolean;
}

export interface GithubCheckSummary {
  name: string;
  status: string;
  conclusion?: string;
  detailsUrl?: string;
}

export interface GithubCommentSummary {
  id: string;
  author?: string;
  body: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface GithubReviewThreadSummary {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path?: string;
  line?: number;
  originalLine?: number;
  comments: GithubCommentSummary[];
}

export interface GithubWriteSummary {
  status: string;
  url?: string;
  id?: string;
  stdout?: string;
}

export interface GitHubClient {
  getIssue(owner: string, repo: string, issueNumber: number): Promise<GithubIssueSummary>;
  getPullRequest(owner: string, repo: string, pullRequestNumber: number): Promise<GithubPullRequestSummary>;
  listPullRequestChecks(owner: string, repo: string, pullRequestNumber: number): Promise<GithubCheckSummary[]>;
  listPullRequestComments?(owner: string, repo: string, pullRequestNumber: number): Promise<GithubCommentSummary[]>;
  listPullRequestReviewThreads?(owner: string, repo: string, pullRequestNumber: number): Promise<GithubReviewThreadSummary[]>;
  updatePullRequest?(input: {
    owner: string;
    repo: string;
    pullRequestNumber: number;
    title?: string;
    body?: string;
    base?: string;
  }): Promise<GithubWriteSummary>;
  setPullRequestReady?(input: {
    owner: string;
    repo: string;
    pullRequestNumber: number;
    ready: boolean;
  }): Promise<GithubWriteSummary>;
  commentOnPullRequest?(input: {
    owner: string;
    repo: string;
    pullRequestNumber: number;
    body: string;
  }): Promise<GithubWriteSummary>;
  updateIssue?(input: {
    owner: string;
    repo: string;
    issueNumber: number;
    title?: string;
    body?: string;
  }): Promise<GithubWriteSummary>;
  updateReviewThread?(input: {
    threadId: string;
    replyBody?: string;
    resolve?: boolean;
  }): Promise<GithubWriteSummary>;
}

