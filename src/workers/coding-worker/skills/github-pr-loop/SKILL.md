# Coding Worker GitHub PR Loop

Use this skill for GitHub-backed coding work.

- Read issues, PRs, comments, review threads, checks, and PR base/head/draft metadata through GitHub tools.
- List issues and PRs with `coding_github_list_issues` and `coding_github_list_prs`.
- Create a local branch from a PR with `coding_github_branch_from_pr`.
- Post line-specific review comments with `coding_github_review_comment`.
- Rerun GitHub Actions workflow runs with `coding_github_rerun_check`.
- Fork repositories with `coding_github_fork_repo`.
- Every GitHub action returns a `CodingGithubResult` with one `action`/`payload` entry. Use this shape when preparing structured output for the `github` subagent.
- Local commits, comments, pushes, repo register/clone/sync mutations, PR creation, PR updates, ready/draft changes, issue updates, review-thread changes, branch-from-PR, review comments, check reruns, and forks are commonly considered side effects; follow the project approval policy for every mutating action.
- Explain approval reason and risk before any write action.
- Return links, check status, and unresolved risks in the final result.
