# Tools

The coding worker may use only capabilities actually attached at runtime.

Wired worker-local capability groups:

- Flue Node local sandbox tools: trusted workspace/project file listing, file reading, literal search, exact patch application, whole-file writes, shell commands, git status, git diff, verification commands, and tests.
- Project creation tools: new projects are created under the configured runtime workspace root in `projects/<slug>`; cloned or existing repositories are resolved under `repos/<slug>`.
- Repo workflow tools: repo discovery, repo registration, clone under `repos/<slug>`, git state, fetch, sync, branch creation, and worktree creation are exposed as first-class tools and scoped to the configured workspace root.
- Approval-gated git tools: local commit and push actions require matching approval decisions.
- Approval-gated GitHub tools: PR creation, PR updates, ready/draft changes, comments, issue updates, and review-thread updates require matching approval decisions.
- GitHub context tools: read issue, PR, check, comment, and review-thread context through the coding-worker GitHub tool boundary, and verify PR base/head/draft metadata explicitly before reporting publish state.
- Approval tools: create backend approval requests for GitHub, git, and repo side effects. The model cannot approve its own requests.
- Durable task-run store: task status, child session names, public events, and verification evidence are persisted under the runtime workspace root.
- Repo support modules: preflight, package-manager detection, verification planning, git-state parsing, and diff summaries.
- Planning tools: `coding_plan_create` builds an explicit initial plan; `coding_plan_replan` updates the plan after verification failure, code-review rejection, or newly discovered context.
- Code intelligence tools: AST parsing (TypeScript, JavaScript, Python), symbol navigation, find declarations, find references, and import-graph analysis across the scoped source files.
  LSP-backed tools (`lsp_document_symbols`, `lsp_go_to_definition`, `lsp_find_references`, `lsp_hover`, `lsp_prepare_rename`, `lsp_rename`, `lsp_workspace_symbols`) are also available; they are powered by `typescript-language-server`, `@astrojs/language-server` (for `.astro`), and `pyright-langserver` from `node_modules/.bin/`, so the published product works out of the box without a system PATH install.
- Event reporting: emit public progress and rationale events for the main orchestrator.

## GitHub Authentication

GitHub authentication is runtime state, not a `TOOLS.md` flag. On the first GitHub operation in a task, check the attached GitHub authentication capability rather than inferring access from a prior conversation. If it reports that authorization is needed, request the approval-gated worker flow and let the authenticated connector privately deliver the browser challenge to the initiating user. Do not copy a browser URL, one-time code, token, or credential into shell output, repository files, commits, progress events, or a final response.

After the user completes the browser authorization, check status again. Do not claim GitHub access until the worker has verified the managed account; do not claim a repository is usable until the requested Git operation also succeeds. Use HTTPS Git remotes only for product-managed GitHub access.

The runtime workspace root is the coding worker's access root. Do not treat the agent source checkout or `process.cwd()` as the default user project. Only use the source checkout as a local development fallback when no runtime workspace root is configured.

Do not use GitHub write actions, repo workflow mutations, clones, syncs, pushes, PR creation, comments, or review-thread updates without backend approval.

Do not invent tools. If a needed capability is not attached, report the limitation through a public progress event and the final result.

## Memory Helper (structured memory, project-scoped)

The coding-worker lead can durably maintain project-scoped structured memory. `projectId` is injected from the worker context; the model cannot supply scope. Memory writes are tracked through the worker audit trail; explicit approval decisions are recorded for handoff operations.

- `coding_task_create_checklist`, `coding_task_add_checklist_item`
- `coding_task_add_todo`, `coding_task_complete_todo`
- `coding_task_store_note`, `coding_task_archive_note`
- `coding_task_search_memory`
- `coding_task_handoff_plan_to_checklist`: copy a finished/blocked task run's `CodingPlanItem[]` into a new durable checklist so the Memory Helper is the cross-run handoff (the run-local plan is the active task plan; the Memory Helper is the cross-run continuity).

Use these to keep a project-level checklist and pinned decisions/conventions across long coding runs. Trust anchor is `taskId`; scope (`projectId`) is injected.
