# Tools

The coding worker may use only capabilities actually attached at runtime.

Wired worker-local capability groups:

- Flue Node local sandbox tools: trusted repo file listing, file reading, literal search, exact patch application, whole-file writes, shell commands, git status, git diff, verification commands, and tests.
- Approval-gated git tools: local commit and push actions require matching approval decisions.
- Approval-gated GitHub tools: PR creation requires a matching approval decision.
- GitHub context tools: read issue, PR, and check context through the coding-worker GitHub tool boundary.
- Approval tools: create approval requests for GitHub and git side effects.
- Repo support modules: preflight, package-manager detection, verification planning, git-state parsing, and diff summaries.
- Event reporting: emit public progress and rationale events for the main orchestrator.

Do not use GitHub write actions, pushes, PR creation, comments, or review-thread updates without approval.

Do not invent tools. If a needed capability is not attached, report the limitation through a public progress event and the final result.
