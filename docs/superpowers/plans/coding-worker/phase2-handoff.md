# Phase 2: Autonomous Coding Worker Swarm Handoff

This document details the required implementations for the parallel branches of the coding-worker swarm now that the Phase 1 Loop Contract is established. Each agent picking up a branch should implement its specific scoped logic, referencing the shared schemas added in Phase 1.

## Foundational Contract (Completed in Phase 1)
- The Orchestrator correctly delegates using natural language.
- `CodingSubagentStructuredOutput` and typed results are correctly defined in `src/workers/coding-worker/types.ts`.
- Loop events `coding.tool.started` and `coding.tool.completed` were added to `coding-worker-events.ts`.
- The task state persistence tracks `CodingWorkerEvent`s natively.

## The Flue-Native Loop (Shared Effort)
The legacy state machine `runCodingTaskWorkflow` must be removed from `src/workers/coding-worker/workflow/coding-task.ts`. The implementation must be replaced by giving the `coding-worker` lead the explicitly defined subagent tools (wrapping the internal agents) and letting the model perform tool calling in a bounded, approval-gated tool-calling loop using the Flue context budget.

## Sibling Branches

### 1. `codex/coding-worker-implementer` (Completed)
Owns: `src/workers/coding-worker/subagents/implementer/`
- Update the implementer subagent to emit the exact `CodingImplementerResult` structured output defined in the types. *(Completed via `coding_implementer_submit_result` tool)*
- Build tools to emit `CodingFileEdit` correctly based on file contents. *(Completed by updating `coding_repo_apply_patch` and `TOOLS.md` instructions)*

### 2. `codex/coding-worker-test-debug`
Owns: `src/workers/coding-worker/subagents/test-debug/`
- Make the test-debug subagent emit `CodingTestDebugResult`, parsing failing tests and emitting focused debug edits.

### 3. `codex/coding-worker-code-review`
Owns: `src/workers/coding-worker/subagents/code-review/`
- Make the code-review subagent emit `CodingCodeReviewResult` containing discrete findings.
- Implement logic in the loop that pauses or alters iteration if `approved` is false.

### 4. `codex/coding-worker-planning`
Owns: `src/workers/coding-worker/subagents/triage/`
- Make the triage subagent emit `CodingTriageResult` which builds the initial explicit plan.
- Create explicit replanning tools available to the lead `coding-worker` agent to update the plan when failures occur.

### 5. `codex/coding-worker-github-surface`
Owns: `src/workers/coding-worker/github/`
- Ensure all GitHub related actions output `CodingGithubResult` using the defined payload shapes. Update PR checks, handle draft status, branch from PR, etc.

*Important:* All logic must remain fail-closed and strictly require approval records for mutating commands via `evaluateGitApproval` and `evaluateRepoApproval`.
