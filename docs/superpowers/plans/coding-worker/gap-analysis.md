# Coding Worker Gap Analysis

*Repository:* `astro-flue-agent`
*Branch context:* `codex/coding-worker-runtime-approvals` (PR #14)
*Updated:* 2026-06-13

## Purpose of this document

PR #14 adds the runtime approval and workspace-scoping layer under `src/workers/coding-worker/`. It is intentionally a **runtime layer only**, not a complete autonomous coding agent. This document records the exact gap between PR #14 and a full Codex-class coding agent, provides a concrete goal, and lists the files any future agent should read before continuing.

Any agent picking up this work from a clean session should read this file first, then inspect the listed source files, then implement the goal below. Do not declare the coding agent goal complete until the "What done looks like" section is satisfied.

## Critical project rules

- **ALL PRs must target `main` by default.** Before declaring any PR work complete, verify with `gh pr view <n> --json baseRefName,headRefName,isDraft` that `baseRefName` is `main` and `isDraft` is `false` when review automation is expected.
- The coding worker is **orchestrator-only**. The main orchestrator exposes only the `coding-worker` lead. Internal `coding-worker-*` subagents must never be visible to the orchestrator.
- All mutating side effects (commit, push, repo mutations, GitHub writes) must go through the approval service and be fail-closed.
- Execution uses Flue's Node local sandbox, scoped under `workspaceRoot` (`projects/<slug>` or `repos/<slug>`). `process.cwd()` is only a local-dev fallback.
- The researcher subagent owns web research; the coding worker does not do web search.
- `Gorombo` is the company, not the default product name. Keep labels distinct.

## Current state

PR #14 is rebased on `main`, open, not draft, and tests/typecheck pass. It contains:

- Approval subsystem under `src/workers/coding-worker/approvals/` (policy, service, store, types).
- Scoped Flue Node local sandbox under `src/workers/coding-worker/tools/` (file, shell, git, repo workflow, command policy).
- GitHub client/tools/policy for read context and approval-gated writes.
- Durable task-run JSON store under `src/workers/coding-worker/session/`.
- Typed public progress events under `src/workers/coding-worker/events/`.
- Internal worker-local subagent profiles: `triage`, `implementer`, `test-debug`, `code-review`, `github`.
- Repo support modules: workspace target resolution, repo registry, preflight, verification planning, package-manager detection, git-state parsing, diff summaries.
- Expanded unit tests.

## What "full coding agent" means here

The agent/worker part must be able to take a natural-language coding task, plan, read code, generate edits, run tests, debug on failure, commit, push, and open/update PRs — without a human pre-supplying every `fileEdit` and `verificationCommand`. This document focuses on that worker capability layer, not Telegram/TUI transport.

## Remaining gaps

1. **No closed-loop autonomy.** `runCodingTaskWorkflow` in `src/workers/coding-worker/workflow/coding-task.ts` is only exercised by tests. The live Flue profile in `src/workers/coding-worker/coding-worker.ts` exposes tools and subagents but does not drive a bounded, approval-gated tool-calling loop for planning, execution, and replanning.
2. **Subagents are thin shells.** `src/workers/coding-worker/subagents/index.ts` returns profiles, but there is no delegation loop that gives each subagent a tool-calling turn and consumes structured outputs. `createFlueCodingSubagentDelegate` in `workflow/coordination.ts` returns free text, not structured plans/edits/findings.
3. **No generated edits.** The implementer subagent does not produce `CodingFileEdit` objects. The workflow applies only caller-supplied `fileEdits`/`debugEdits`.
4. **No iteration on failure.** When verification fails, the workflow runs at most one rerun with pre-supplied `debugEdits`. There is no loop back to planning/implementation with failure context.
5. **No planning/replanning tool.** The plan is a static list created upfront. Nothing lets the lead or subagents update it based on discovered context.
6. **No code intelligence.** Tools are limited to file listing, reading, and literal substring search. No AST parsing, symbol navigation, import graph, or LSP integration.
7. **Incomplete GitHub surface.** Missing: PR list, issue list, branch-from-PR, line-specific review comments, check rerun, fork handling, and robust base-branch defaulting to `main`.
8. **No human approval transport.** The approval service is file-backed with an in-memory dev resolver. A user-facing approval mechanism (TUI/Telegram/Discord) is not built.
9. **No test-result parsing.** Verification checks exit codes only; it does not parse Jest/Vitest/pytest output to identify failing files/lines.
10. **No transaction/rollback for multi-file edits.** Edits are applied one at a time; a mid-batch failure leaves partial state.
11. **No durable project-level memory.** `JsonFileCodingTaskRunStore` persists a single run, but there is no project memory of prior tasks, conventions, or decisions.
12. **No streaming/real-time progress.** Events are batched and returned at the end of the run.
13. **No retry/recovery for transient failures** (network, `gh` CLI, sandbox).

## Proposed next goal (under 4000 characters)

> Close the autonomy gap in `src/workers/coding-worker` so the lead Flue profile can execute a model-driven, multi-turn coding workflow end-to-end from a natural-language task to verified, committed code. We will replace the hardcoded `runCodingTaskWorkflow` state machine with a **Flue-native loop** where the `coding-worker` lead is given explicit planning/replanning tools and directly orchestrates the subagents via tool calling. The main orchestrator will delegate to the `coding-worker` using natural language rather than building structured payloads itself. Give each internal subagent a structured tool-calling turn that returns concrete outputs (files to read, exact edits, verification commands, review findings, GitHub actions), and let the lead iterate: replan when blocked, rerun tests after generated debug edits, and drive approval-gated commits, pushes, and PR creation. Add a planning/replanning tool, generated-edit output from the implementer, structured test-result parsing, and a bounded, approval-gated tool-calling loop run resume. Keep all PRs targeting `main` by default and cover the loop with unit + integration tests. Do not declare complete until an integration test proves the agent can take a natural-language bug-fix task, edit code, pass tests, commit, and push to a feature branch through an approval gate.

## Recommended plan

1. Merge PR #14 as the foundational runtime approval layer. Do not expand its scope.
2. Create a new branch from `main`, e.g. `codex/coding-worker-autonomous-loop`. It must target `main`.
3. Build the loop in focused, reviewable PRs:
   - Establish the **Flue-native loop contract**: Define I/O schemas for subagents, typed progress events, and the task-run state persistence.
   - Wire the subagent tools into the lead coding-worker profile so it can delegate and loop.
   - Structured subagent outputs + generated edits (implementer/test-debug emit `CodingFileEdit`, verification commands, review findings).
   - Planning/replanning tool and iteration loop (dynamic plan updates, failure-driven replanning).
   - Structured test-result parsing.
   - Expanded GitHub surface and approval transport adapter (TUI/Telegram/Discord).
   - Code-intelligence tools (AST parsing, symbol navigation, import graph, explicit LSP integration, semantic search).
4. Before declaring each PR complete, verify PR metadata with `gh pr view <n> --json baseRefName,headRefName,isDraft`.

## What "done" looks like

An integration test must prove the coding worker can take a natural-language task like "fix the off-by-one bug in `src/utils.ts` and open a PR" and, without human hand-holding:

1. Triage the task and choose subagents/tools.
2. Read relevant files and identify the bug.
3. Generate and apply one or more exact-text edits.
4. Run focused verification, then required verification.
5. If tests fail, enter a debug loop with generated fixes and rerun until passing.
6. Run final checks (e.g., `git diff --check`).
7. Create an approval-gated commit.
8. Push to a feature branch (approval-gated).
9. Open a PR against `main` (approval-gated) with a descriptive title and body.
10. Return a structured result with verification evidence, links, and public progress events.

Until that test passes, the coding agent goal is **not complete**.

## Key files to audit before continuing

Core:
- `src/workers/coding-worker/coding-worker.ts`
- `src/workers/coding-worker/types.ts`
- `src/workers/coding-worker/workflow/coding-task.ts`
- `src/workers/coding-worker/workflow/coordination.ts`
- `src/workers/coding-worker/workflow/result-schema.ts`
- `src/workers/coding-worker/subagents/index.ts`
- `src/workers/coding-worker/subagents/profile-factory.ts`

Tools and runtime:
- `src/workers/coding-worker/tools/coding-repo-tools.ts`
- `src/workers/coding-worker/tools/coding-git-tools.ts`
- `src/workers/coding-worker/tools/coding-repo-workflow-tools.ts`
- `src/workers/coding-worker/tools/sandbox-runtime.ts`
- `src/workers/coding-worker/tools/command-policy.ts`
- `src/workers/coding-worker/runtime-capabilities.ts`

GitHub:
- `src/workers/coding-worker/github/github-tools.ts`
- `src/workers/coding-worker/github/github-client.ts`
- `src/workers/coding-worker/github/gh-cli-client.ts`

State and events:
- `src/workers/coding-worker/session/task-run-store.ts`
- `src/workers/coding-worker/events/coding-worker-events.ts`
- `src/workers/coding-worker/events/progress-reporter.ts`
- `src/workers/coding-worker/events/orchestrator-bridge.ts`

Repo support:
- `src/workers/coding-worker/repo/workspace-target.ts`
- `src/workers/coding-worker/repo/repo-registry.ts`
- `src/workers/coding-worker/repo/preflight.ts`
- `src/workers/coding-worker/repo/verification.ts`
- `src/workers/coding-worker/repo/package-manager.ts`
- `src/workers/coding-worker/repo/git-state.ts`
- `src/workers/coding-worker/repo/diff-summary.ts`

Skills and workspace:
- `src/workers/coding-worker/skills.ts`
- `src/workers/coding-worker/skills/*/SKILL.md`
- `src/workers/coding-worker/workspace/AGENTS.md`
- `src/workers/coding-worker/workspace/TOOLS.md`

Tests:
- `src/tests/coding-worker.test.ts`
- `src/tests/architecture-contract.test.ts`

## Verification discipline

Before declaring any future coding-worker work complete, run:

```sh
corepack pnpm run typecheck
corepack pnpm run test:unit
corepack pnpm test
git diff --check
```

Then verify PR metadata with `gh pr view <n> --json baseRefName,headRefName,isDraft,state`.

---

*Generated: 2026-06-13*
