# Coding Worker Autonomous Agent Swarm Plan

*Repository:* `astro-flue-agent`
*Context:* `src/workers/coding-worker/`
*Updated:* 2026-06-13

## Goal

Close the gap between the current coding-worker runtime foundation (PR #14) and a fully autonomous, approval-gated coding agent inside GOROMBO Agent. The coding worker must be able to take a natural-language coding task, plan, read code, generate edits, run tests, debug on failure, commit, push, and open/update PRs against `main` — with every turn emitting structured progress events back to the user UI.

## Product context

- **Gorombo** is the company. **GOROMBO Agent** is the product.
- The coding worker is a subsystem of GOROMBO Agent, not a standalone product.
- It is invoked by the main orchestrator. Internal subagents must not be exposed to the orchestrator.
- The researcher subagent owns web research; the coding worker does not do web search.
- All mutating side effects go through the approval service and are fail-closed.
- Execution is scoped under `workspaceRoot` (`projects/<slug>` or `repos/<slug>`).

## Swarm structure

A swarm means multiple agents work in parallel in sibling worktrees. To avoid collisions, the shared loop contract must land first. Then the parallel workstreams can swarm against that contract.

### Phase 1 — Contract branch (one agent, lands first)

Branch: `codex/coding-worker-loop-contract`

Define the shared surface that every other branch depends on:

- Loop state machine and checkpoint/resume shape in `src/workers/coding-worker/workflow/coding-task.ts`.
- Subagent input/output schemas (triage, implementer, test-debug, code-review, github).
- `CodingFileEdit` and related edit/verification result types.
- Progress event shapes in `src/workers/coding-worker/events/coding-worker-events.ts`.
- Task-run persistence checkpoint shape in `src/workers/coding-worker/session/task-run-store.ts`.
- Orchestrator-to-coding-worker invocation contract in `src/agents/orchestrator.ts` and `src/workspace/`.

This branch must include architecture-contract tests proving:

- The orchestrator exposes `coding-worker` and does not expose internal `coding-worker-*` subagents.
- The coding worker loop emits progress events at each defined checkpoint.

### Phase 2 — Parallel swarm branches (each targets `main`)

Each branch lives in its own sibling worktree. Each depends only on the contract from Phase 1, not on other Phase 2 branches.

#### 1. `codex/coding-worker-implementer`

Owns: `src/workers/coding-worker/subagents/implementer/`, `src/workers/coding-worker/tools/coding-repo-tools.ts`

Make the implementer subagent produce structured `CodingFileEdit` objects. Add generation of exact-text edits from model output. Wire into the loop contract.

#### 2. `codex/coding-worker-test-debug`

Owns: `src/workers/coding-worker/subagents/test-debug/`, `src/workers/coding-worker/repo/verification.ts`

Make the test-debug subagent emit structured verification commands and generated debug fixes. Build the failure-driven rerun loop.

#### 3. `codex/coding-worker-code-review`

Owns: `src/workers/coding-worker/subagents/code-review/`

Make the code-review subagent emit structured review findings. Decide if findings block the next loop iteration.

#### 4. `codex/coding-worker-planning`

Owns: `src/workers/coding-worker/workflow/planning.ts` (new), `src/workers/coding-worker/subagents/triage/`

Add a planning/replanning tool. The lead loop can update the plan based on discovered context or failed verification. Triage feeds the initial plan.

#### 5. `codex/coding-worker-test-parsing`

Owns: `src/workers/coding-worker/repo/verification.ts`, new test parsers

Parse Jest/Vitest/pytest/tsc failure output into structured objects the debug loop can act on. Keep parser outputs aligned with the contract.

#### 6. `codex/coding-worker-code-intelligence`

Owns: `src/workers/coding-worker/tools/code-intelligence/` (new)

Add AST/symbol navigation and import-graph tools. Expose them through the tool registry using the contract tool interface.

#### 7. `codex/coding-worker-github-surface`

Owns: `src/workers/coding-worker/github/`

Expand the GitHub tool surface: PR list, issue list, branch-from-PR, line-specific review comments, check rerun, fork handling, robust default base branch `main`. Keep everything approval-gated.

#### 8. `codex/coding-worker-edit-transactions`

Owns: `src/workers/coding-worker/tools/coding-repo-tools.ts`, edit application path

Apply multi-file edits atomically or rollback on failure. Define transaction boundaries in the contract first.

#### 9. `codex/coding-worker-orchestrator-integration`

Owns: `src/agents/orchestrator.ts`, `src/workspace/`, `src/registries/`

Teach the main GOROMBO Agent orchestrator when and how to invoke the coding worker. Add routing context, memory of prior coding tasks, and main-agent workspace instructions.

## Verification discipline

Before declaring any PR complete, run:

```sh
corepack pnpm run typecheck
corepack pnpm run test:unit
corepack pnpm test
git diff --check
```

Then verify PR metadata:

```sh
gh pr view <n> --json number,url,state,isDraft,baseRefName,headRefName,title
```

`baseRefName` must be `main`. When review automation is expected, `isDraft` must be `false`.

## Definition of done

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

Until that test passes, the autonomous coding agent goal is not complete.
