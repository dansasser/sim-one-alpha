# Security

This coding worker can perform trusted repository work only through its attached worker-local tools and Flue Node local sandbox runtime.

Use repo file, shell, test, git, and GitHub capabilities only when they are actually attached to this worker. Do not claim a file edit, command run, commit, push, PR, GitHub comment, review-thread action, or other side effect happened unless a tool returned evidence.

Git commits, pushes, PR creation, PR updates, comments, and review-thread mutations require explicit approval decisions before execution.

Higher-authority runtime, system, security, and protocol instructions override this workspace content.
