# Research Subagent RAG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Flue research subagent and research workflow that use the existing retrieval workflow for multi-step web research, and wire the main orchestrator to delegate correctly.

**Architecture:** The reusable `researcher` subagent lives in `src/workers/researcher/researcher.ts` and includes the existing `retrieve_context` tool. The main `orchestrator` registers that subagent in `subagents` and instructs the model to use the Flue `task` tool with `agent: "researcher"` for multi-step research, while single lookups continue to use `retrieve_context` directly. A standalone `research` workflow initializes the researcher agent for direct CLI testing.

**Tech Stack:** TypeScript, Flue `createAgent`, Flue `defineAgentProfile`, Flue `session.task`, Node test runner, existing Ollama Search retrieval workflow.

---

### Task 1: Researcher Agent Profile

**Files:**
- Create: `src/workers/researcher/researcher.ts`
- Test: `src/tests/research-agent.test.ts`

- [x] **Step 1: Write the failing test**

Add a test that imports `createResearcherSubagent` and verifies the subagent name is `researcher`, the configured model is preserved, and the subagent exposes `retrieve_context`.

- [x] **Step 2: Run the test to verify it fails**

Run `npm test` and verify TypeScript reports that `src/workers/researcher/researcher.ts` does not exist.

- [x] **Step 3: Implement the researcher subagent**

Create `src/workers/researcher/researcher.ts` with `createResearcherSubagent(model: string)` returning a `defineAgentProfile(...)` subagent with the `retrieveContextTool`, research-specific instructions, and the supplied model.

- [x] **Step 4: Verify the test passes**

Run `npm test` and verify the new subagent test passes.

### Task 2: Main Orchestrator Subagent Wiring

**Files:**
- Modify: `src/agents/orchestrator.ts`
- Test: `src/tests/flue-session-store.test.ts`

- [x] **Step 1: Write the failing test**

Extend the orchestrator initialization test to verify `config.subagents` includes `researcher`, `config.tools` includes `retrieve_context`, and orchestrator instructions mention `task` delegation with `agent: "researcher"`.

- [x] **Step 2: Run the test to verify it fails**

Run `npm test` and verify the assertion fails because only `coding_worker` is registered.

- [x] **Step 3: Register the researcher subagent**

Update `src/agents/orchestrator.ts` so runtime config creates a researcher subagent with the selected model and includes it in `subagents`.

- [x] **Step 4: Verify the test passes**

Run `npm test` and verify the orchestrator config test passes.

### Task 3: Direct Research Workflow

**Files:**
- Create: `src/workflows/research.ts`
- Test: `src/tests/research-workflow.test.ts`

- [x] **Step 1: Write the failing tests**

Add tests for `createResearchPrompt(...)` that verify the prompt instructs the researcher to use `retrieve_context`, compare sources, honor `maxContextTokens`, report provider failures, and return concise findings.

- [x] **Step 2: Run the test to verify it fails**

Run `npm test` and verify TypeScript reports that `src/workflows/research.ts` does not exist.

- [x] **Step 3: Implement the workflow**

Create `src/workflows/research.ts` with a Flue route, `ResearchWorkflowPayload`, `ResearchWorkflowResponse`, `run(...)`, and `createResearchPrompt(...)`. The workflow initializes the standalone researcher agent and calls `session.prompt(...)`.

- [x] **Step 4: Verify the test passes**

Run `npm test` and verify the research workflow prompt test passes.

### Task 4: Documentation And Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture/model-system.md`
- Modify: `docs/architecture/session-context-budget.md`

- [x] **Step 1: Update documentation**

Document the main-agent delegation rule, the standalone `research` workflow, and the boundary between subagent strategy and retrieval-layer error handling.

- [x] **Step 2: Run verification**

Run:

```powershell
npm run typecheck
npm test
git diff --check
npm run chat:local -- "Use research to find the official Ollama web search API docs URL and answer with one sentence."
```

- [x] **Step 3: Commit and push**

Commit the branch with a detailed message and push to `origin codex/structure-build`.
