# Coding Worker — Future Enhancements (Post-Finish)

*Repository:* `sim-one-alpha`
*Path:* `src/workers/coding-worker/`
*Updated:* 2026-06-14

These are the capabilities that sit **above** the [Finish the Coding Worker Product](./plan.md) plan. They move the agent from "production-usable" to "top-notch" — comparable to the most capable coding agents.

Do not start these until the finish plan is complete and the integration test passes with a real model.

## 1. Long-Horizon Planning

Break a single user goal into multiple dependent coding tasks, execute them in order, and recover when earlier tasks invalidate later ones.

Examples:

- "Add OAuth login" → plan, implement, test, and land it as a series of smaller PRs.
- Track dependencies between tasks in a durable plan graph.
- Replan when a prior task's implementation changes the design of a later task.

Likely work:

- `src/workers/coding-worker/workflow/long-horizon-planner.ts`
- Persistent plan graph keyed by project.
- Integration with durable project memory.

## 2. Multi-Repo / Monorepo Awareness

Operate across multiple repositories or packages in a single workspace without losing context.

Examples:

- Change a shared library and update all dependent services in the same task.
- Respect workspace boundaries (pnpm workspace, npm workspace, Cargo workspace, Poetry monorepo).
- Run the right verification command in the right package.

Likely work:

- Extend `workspace-target.ts` to support multi-root workspaces.
- Add package-level dependency analysis via LSP/import graph.
- Cross-repo PR orchestration in the GitHub subagent.

## 3. Advanced Refactoring

Go beyond exact-text edits to semantic refactorings.

Examples:

- Rename a symbol across files.
- Move a function/class to a different file and update all imports.
- Extract a reusable helper with references updated automatically.
- Inline a variable or function safely.

Likely work:

- Expand the LSP gateway with `rename`, `executeCommand`, and workspace edits.
- Add a refactoring tool layer on top of `lsp_*` tools.
- Approval-gate refactorings because they can touch many files.

## 4. Rich TUI / Web IDE Integration

Move beyond Telegram buttons to a purpose-built coding surface.

Examples:

- Side-by-side diff view before approval.
- Inline review comments on proposed changes.
- Live terminal output during verification.
- Keyboard shortcuts for Approve / Deny / Replan.

Likely work:

- WebSocket or SSE stream from the progress reporter.
- Web UI components for diff, plan, and approval.
- TUI using a terminal UI library (e.g., Ink, Bubble Tea, or a webview).

## 5. Intelligent Test Selection

Run only the tests that matter for the changed code, and expand to full suites when warranted.

Examples:

- Map edits to affected test files via import graph and LSP references.
- Run focused tests first; fall back to full suite on failure.
- Cache historical test results and failure signatures.
- Suggest new tests when coverage gaps are found.

Likely work:

- `src/workers/coding-worker/repo/test-selection.ts`
- Integration with LSP references and coverage data.
- Machine-readable coverage reporting from verification parsers.

## 6. Cost / Quality Model Routing

Use cheaper models for low-risk steps and expensive models only where they matter.

Examples:

- Use a small/fast model for parsing, formatting, and simple edits.
- Use a large model for triage, complex debugging, and code review.
- Automatically retry with a stronger model if a cheaper one fails.

Likely work:

- Model routing policy in `src/models/`.
- Subagent-level model selection in the coding worker loop.
- Telemetry on cost vs. success rate per model and subagent.

## 7. Fault Recovery Beyond Retry

Handle failures that are not fixed by simple retries.

Examples:

- Detect a wedged LSP server and restart it.
- Recover from a dirty git state before applying edits.
- Automatically create a fresh worktree if the current one is corrupt.
- Surface persistent failures to the user with a clear abort/restart choice.

Likely work:

- Health checks for external processes.
- Git state sanitization helpers.
- Worktree lifecycle manager.

## 8. Cross-Session Learning

Learn from repeated work on the same codebase across tasks and users.

Examples:

- Remember common failure patterns and their fixes.
- Build a project-specific "agent handbook" automatically.
- Suggest better verification commands after observing what actually catches bugs.

Likely work:

- Extend durable project memory with outcome learning.
- Feedback loop from merged/closed PRs.
- Optional human correction ingestion.

## Suggested Order After Finish

1. **Intelligent test selection** — high impact, builds on LSP and verification parsers already in flight.
2. **Advanced refactoring** — builds on the LSP gateway.
3. **Multi-repo awareness** — needed as soon as the agent is used on real Gorombo work.
4. **Long-horizon planning** — enables the agent to own larger projects without micromanagement.
5. **Rich TUI / web IDE** — improves the approval and progress experience significantly.
6. **Cost/quality routing** — optimize once usage volume justifies it.
7. **Fault recovery beyond retry** — harden production behavior.
8. **Cross-session learning** — long-term quality improvement.
