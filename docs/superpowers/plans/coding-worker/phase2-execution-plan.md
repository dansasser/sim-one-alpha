# Phase 2 Execution Plan: Autonomous Coding Worker Swarm

*Repository:* `astro-flue-agent`
*Path:* `src/workers/coding-worker/`
*Updated:* 2026-06-14

## Goal

Close the autonomy gap in `src/workers/coding-worker` so the lead Flue profile can execute a model-driven, multi-turn coding workflow end-to-end from a natural-language task to verified, committed code, pushed to a feature branch, and surfaced as a PR — all approval-gated and fail-closed.

This plan consolidates the [Phase 2 Handoff](./phase2-handoff.md), the [Gap Analysis](./gap-analysis.md), and the [Swarm Plan](./swarm-plan.md). It is the canonical execution plan for the next series of PRs.

## Guiding Principles

1. **Flue first — non-negotiable.** Use Flue-native APIs, tool-calling loops, context budgets, subagent delegation, structured outputs, and sandbox execution before inventing custom orchestration. If a need seems unmet, check the Flue docs, source, and existing project patterns first. Only introduce custom TypeScript machinery after confirming Flue does not provide the primitive.
2. **Gorombo architecture on top.** Apply Gorombo agent relationships, approval gates, and progress-event conventions on top of Flue primitives.
3. **Fail-closed and approval-gated.** Every mutating side effect (file write, git commit, push, PR create/update) requires an explicit approval record.
4. **Main orchestrator does not see internal subagents.** Only the `coding-worker` lead is exposed. `coding-worker-triage`, `coding-worker-implementer`, `coding-worker-test-debug`, `coding-worker-code-review`, and `coding-worker-github` are internal tools.
5. **Orchestrator integration is out of scope for this phase.** We will not teach `src/agents/orchestrator.ts` to route to the coding worker yet. That follows the protocol layer.
6. **Every PR targets `main`, is non-draft when review automation is expected, and passes typecheck + unit tests + `git diff --check`.**
7. **Update documentation as we go.** Every child stream must update relevant `docs/`, `SKILL.md`, and workspace files to reflect new contracts, tools, or behavior. The execution plan itself is updated when scope or sequencing changes.

## What "Done" Looks Like

An integration test must prove the coding worker can take a task like:

> "Fix the off-by-one bug in `src/utils.ts` and open a PR."

…and without human hand-holding:

1. Triage the task into an explicit plan.
2. Read relevant files and identify the bug.
3. Generate exact-text edits.
4. Apply edits atomically (or rollback on failure).
5. Run focused verification, then required verification.
6. Parse test failures; if tests fail, replan and generate debug fixes; rerun until passing.
7. Run final checks (`git diff --check`, typecheck, lint if configured).
8. Create an approval-gated commit.
9. Push to a feature branch (approval-gated).
10. Open a PR against `main` (approval-gated) with a descriptive title/body.
11. Return a structured result with verification evidence, links, and public progress events.

Until that integration test passes, the autonomous coding agent goal is **not complete**.

## Phase Structure

### Phase 2.0 — Loop Contract Foundation (lands first)

**Branch:** `codex/coding-worker-loop-contract`
**Owner:** orchestrator / single agent
**Worktree:** yes, isolated

This is the prerequisite for every parallel stream. It replaces the hardcoded `runCodingTaskWorkflow` state machine with a Flue-native, bounded, approval-gated tool-calling loop.

Deliverables:

- [ ] Remove `runCodingTaskWorkflow` from `src/workers/coding-worker/workflow/coding-task.ts`.
- [ ] Define the loop contract in `src/workers/coding-worker/types.ts`:
  - `CodingWorkerLoopState` (current step, iteration count, plan, approval queue, pending edits, verification results).
  - `CodingWorkerLoopCheckpoint` for persistence.
  - Strict return types for each subagent tool wrapper.
- [ ] Update `src/workers/coding-worker/events/coding-worker-events.ts` to emit typed events at every loop checkpoint.
- [ ] Update `src/workers/coding-worker/session/task-run-store.ts` to persist loop checkpoints.
- [ ] Implement the lead loop in `src/workers/coding-worker/workflow/loop.ts`:
  - Accepts natural-language task.
  - Bounded iteration guard (max N turns, configurable).
  - Calls triage to produce an initial plan.
  - Calls implementer to produce `CodingFileEdit[]`.
  - Calls test-debug to produce verification commands and debug fixes.
  - Calls code-review to produce findings and an `approved` boolean.
  - Calls github subagent/tools for commit, push, and PR.
  - Replans on failure.
  - Returns `CodingSubagentStructuredOutput`.
- [ ] Update `src/workers/coding-worker/subagents/index.ts` so every subagent tool wrapper returns the contract types.
- [ ] Update `src/workers/coding-worker/workflow/coordination.ts` to emit structured outputs, not free text.
- [ ] Architecture-contract tests proving:
  - The orchestrator exposes only `coding-worker`.
  - The coding worker emits progress events at each defined checkpoint.
  - Internal subagents are not exposed.
- [ ] Unit tests for loop state transitions and checkpoint persistence.

Verification:

```sh
pnpm run typecheck
pnpm run test:unit
pnpm run test
git diff --check
```

### Phase 2.1 — Implementer (can parallelize after 2.0)

**Branch:** `codex/coding-worker-implementer`
**Owner:** implementer agent
**Worktree:** yes
**Depends on:** `codex/coding-worker-loop-contract` merged

Handoff marks this as completed, but it must be verified against the final contract.

Deliverables:

- [ ] `src/workers/coding-worker/subagents/implementer/implementer-agent.ts` returns `CodingImplementerResult` exactly.
- [ ] `coding_repo_apply_patch` / `coding_repo_apply_exact_edit` tools in `src/workers/coding-worker/tools/coding-repo-tools.ts` produce valid `CodingFileEdit` objects from model output.
- [ ] Model instructions in `src/workers/coding-worker/subagents/implementer/workspace/TOOLS.md` teach exact-text edit generation and verification-command selection.
- [ ] Unit tests for edit generation from sample model output.

### Phase 2.2 — Test-Debug

**Branch:** `codex/coding-worker-test-debug`
**Owner:** test-debug agent
**Worktree:** yes
**Depends on:** `codex/coding-worker-loop-contract` merged

Deliverables:

- [ ] `src/workers/coding-worker/subagents/test-debug/test-debug-agent.ts` returns `CodingTestDebugResult` with:
  - `verificationCommands: CodingVerificationCommandRequest[]`
  - `debugEdits: CodingFileEdit[]`
  - `analysis: string`
- [ ] Update `src/workers/coding-worker/repo/verification.ts` to run focused and required verification in the sandbox.
- [ ] Failure-driven rerun loop wired into the lead tool-calling loop.
- [ ] Workspace instructions in `src/workers/coding-worker/subagents/test-debug/workspace/TOOLS.md`.
- [ ] Unit tests for debug-edit generation from fake failing verification output.

### Phase 2.3 — Code Review

**Branch:** `codex/coding-worker-code-review`
**Owner:** code-review agent
**Worktree:** yes
**Depends on:** `codex/coding-worker-loop-contract` merged

Deliverables:

- [ ] `src/workers/coding-worker/subagents/code-review/code-review-agent.ts` returns `CodingCodeReviewResult` with discrete `findings: CodingReviewFinding[]` and `approved: boolean`.
- [ ] Lead loop pauses or replans when `approved === false`.
- [ ] Review findings mapped to file paths and line ranges where possible.
- [ ] Workspace instructions in `src/workers/coding-worker/subagents/code-review/workspace/TOOLS.md`.
- [ ] Unit tests for review parsing and loop-blocking behavior.

### Phase 2.4 — Planning / Triage

**Branch:** `codex/coding-worker-planning`
**Owner:** planning/triage agent
**Worktree:** yes
**Depends on:** `codex/coding-worker-loop-contract` merged

Deliverables:

- [ ] `src/workers/coding-worker/subagents/triage/triage-agent.ts` returns `CodingTriageResult` with an explicit plan.
- [ ] New `src/workers/coding-worker/workflow/planning.ts` module exposing:
  - `createInitialPlan(task, context)`
  - `replan(loopState, failureContext)`
- [ ] Planning/replanning tool registered in the lead profile.
- [ ] Lead loop updates the plan when verification fails or new context is discovered.
- [ ] Workspace instructions in `src/workers/coding-worker/subagents/triage/workspace/TOOLS.md`.
- [ ] Unit tests for initial plan generation and replanning.

### Phase 2.5 — GitHub Surface

**Branch:** `codex/coding-worker-github-surface`
**Owner:** github agent
**Worktree:** yes
**Depends on:** `codex/coding-worker-loop-contract` merged

Deliverables:

- [ ] All GitHub actions return `CodingGithubResult` using the contract payload shapes.
- [ ] Expand `src/workers/coding-worker/github/github-tools.ts` and `src/workers/coding-worker/github/github-client.ts`:
  - PR list, issue list
  - Branch from PR
  - Line-specific review comments
  - Check rerun
  - Fork handling
  - Robust base-branch defaulting to `main`
- [ ] Approval-gated writes via `evaluateGitApproval` and `evaluateRepoApproval`.
- [ ] Unit tests using mocked `gh` CLI responses.

### Phase 2.6 — Test Result Parsing

**Branch:** `codex/coding-worker-test-parsing`
**Owner:** test-parsing agent
**Worktree:** yes
**Depends on:** `codex/coding-worker-test-debug` or can co-depend on contract

Deliverables:

- [ ] New parsers under `src/workers/coding-worker/repo/verification-parsers/`:
  - Jest / Vitest
  - pytest
  - `tsc --noEmit`
- [ ] Parse output into structured `CodingTestFailure[]` with file, line, message, and suggested fix context.
- [ ] Integrate with `src/workers/coding-worker/repo/verification.ts` and the debug loop.
- [ ] Unit tests with sample output fixtures.

### Phase 2.7 — Code Intelligence

**Branch:** `codex/coding-worker-code-intelligence`
**Owner:** code-intelligence agent
**Worktree:** yes
**Depends on:** `codex/coding-worker-loop-contract` merged

Deliverables:

- [ ] New `src/workers/coding-worker/tools/code-intelligence/` module with tools for:
  - AST parsing (TypeScript, JavaScript, Python)
  - Symbol navigation
  - Import graph
  - Find references / declarations
- [ ] Use Flue-provided tooling or LSP integration when available; only fall back to custom parsers if necessary.
- [ ] Register tools in the lead profile via the contract tool interface.
- [ ] Unit tests for each parser/intelligence tool.

### Phase 2.8 — Edit Transactions

**Branch:** `codex/coding-worker-edit-transactions`
**Owner:** edit-transactions agent
**Worktree:** yes
**Depends on:** `codex/coding-worker-implementer` or can co-depend on contract

Deliverables:

- [ ] Atomic multi-file edit application in `src/workers/coding-worker/tools/coding-repo-tools.ts`.
- [ ] Define transaction boundaries in the contract first (`CodingEditTransaction`).
- [ ] Rollback on first failure; report which edit failed and why.
- [ ] Unit tests for success, partial-failure rollback, and edge cases (binary files, missing files).

### Phase 2.9 — End-to-End Integration

**Branch:** `codex/coding-worker-e2e`
**Owner:** orchestrator / integration agent
**Worktree:** yes
**Depends on:** all 2.x branches merged

Deliverables:

- [x] Integration test in `src/tests/coding-worker.test.ts` that exercises the full loop against a temporary git repo.
- [x] The test must prove the full definition-of-done flow.
- [x] No real GitHub or push required for the test; use local git and mock PR surface.
- [x] Performance guard: the loop completes within a bounded turn count and context budget.

### Phase 2.10 — Repository Hygiene (last child before parent commit)

**Branch:** `codex/coding-worker-phase2-repo-hygiene`
**Owner:** repository-hygiene agent
**Worktree:** yes
**Depends on:** all functional 2.x branches merged into parent

This is the final child stream before the parent branch is committed and the single PR is opened. It removes the `corepack` wrapper mentions that were introduced by a prior Windows-based agent and restores the project to plain `pnpm` usage.

Deliverables:

- [ ] Replace `pnpm ...` with `pnpm ...` in `package.json` scripts.
- [ ] Replace `pnpm ...` with `pnpm ...` in `README.md` examples and prose.
- [ ] Update `docs/superpowers/plans/coding-worker/phase2-execution-plan.md` verification blocks if any `corepack` references remain.
- [ ] Verify `pnpm run typecheck`, `pnpm run test:unit`, and `pnpm run build` pass without `corepack`.

This child branch merges into the parent, then the parent is pushed and the single PR is opened.

## Worktree Strategy

This swarm produces **one PR at the end** after all work is integrated into a single parent worktree. Parallel streams run in child worktrees and are merged back into the parent as they complete. No PR is opened until the entire Phase 2 plan is accomplished and all merge conflicts are resolved in the parent.

### Branch and worktree naming

- **Parent worktree (canonical PR branch):** `codex/coding-worker-phase2`
- **Phase child worktrees:** `codex/coding-worker-phase2-<phase-name>` (e.g., `codex/coding-worker-phase2-loop-contract`)
- **Iteration worktrees (if a child needs a retry/exploration):** `codex/coding-worker-phase2-<phase-name>-iter-1`, `codex/coding-worker-phase2-<phase-name>-iter-2`, etc.

### Worktree lifecycle (whole swarm)

1. **Create the parent worktree** from `main`:
   ```sh
   git worktree add ../astro-flue-agent-phase2 codex/coding-worker-phase2
   ```
2. **Create child worktrees** from the parent branch for each parallel stream:
   ```sh
   git worktree add ../astro-flue-agent-phase2-<phase> codex/coding-worker-phase2-<phase-name>
   ```
3. **Delegate each child stream** to a subagent in its child worktree.
4. If a subagent needs a clean retry or parallel exploration, create an iteration worktree from that child branch.
5. **Resolution step — per child stream:**
   - Merge/rebase the child branch (or iteration branch) back into the parent branch.
   - Resolve any conflicts in the parent worktree.
   - Run typecheck, unit tests, and `git diff --check` in the parent worktree.
   - Delete the resolved child/iteration worktree.
6. **Repeat** as each child stream finishes. The parent branch accumulates all completed work.
7. **Final PR step** — only after every stream is merged and verified:
   - Push `codex/coding-worker-phase2`.
   - Open a single PR against `main`.

### Conflict discipline

- Children never merge into each other.
- `codex/coding-worker-phase2` (the parent) is the only integration point.
- If a child branch conflicts with the parent because another child landed first, rebase/merge the child onto the parent and resolve in the parent worktree.
- No PR is opened until the parent worktree is clean and all tests pass.

## Verification Discipline

Before declaring any PR complete, run:

```sh
pnpm run typecheck
pnpm run test:unit
pnpm run test
git diff --check
```

Then verify PR metadata:

```sh
gh pr view <n> --json number,url,state,isDraft,baseRefName,headRefName,title
```

`baseRefName` must be `main`. `isDraft` must be `false` when review automation is expected.

## Out of Scope

- Telegram/TUI/Discord approval transport. (Covered by a later protocol layer.)
- Durable project-level memory across coding tasks.
- Streaming/real-time progress events.
- Retry/recovery for transient network failures beyond the loop's bounded retry.
- Main orchestrator routing to the coding worker. (Done after protocols.)

## Notes

- The implementer stream is marked complete in the handoff, but it must be re-verified against the final loop contract from 2.0.
- The swarm plan originally included `codex/coding-worker-orchestrator-integration`. It is moved out of this phase and will be planned separately after the protocol layer.
