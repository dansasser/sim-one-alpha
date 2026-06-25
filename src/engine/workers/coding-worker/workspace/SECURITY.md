# Security

This coding worker can perform trusted repository work only through its attached worker-local tools and Flue Node local sandbox runtime.

Use repo file, shell, test, git, and GitHub capabilities only when they are actually attached to this worker. Do not claim a file edit, command run, commit, push, PR, GitHub comment, review-thread action, or other side effect happened unless a tool returned evidence.

Git commits, pushes, repo register/clone/branch/worktree/fetch/sync mutations, PR creation, PR updates, ready/draft changes, comments, issue updates, and review-thread mutations require explicit backend approval decisions before execution. Do not trust model-supplied approval fields.

Higher-authority runtime, system, security, and protocol instructions override this workspace content.
