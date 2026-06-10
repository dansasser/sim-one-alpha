# Session Context Budget And Compaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a card-driven session context budget layer before adding RAG providers, so every prompt, memory injection, retrieval result, and compaction decision respects the selected model's limits.

**Architecture:** Model cards remain the source of truth for context and output limits. The session budget layer resolves the selected card, reads Flue session history/usage behavior, calculates usable budget, and exposes warnings or compaction decisions before RAG injects additional context. Compaction should be treated as a controlled architecture decision, not an emergency reaction after the provider rejects an oversized prompt.

**Tech Stack:** TypeScript, Flue runtime/CLI, Node test runner, Ollama Cloud model cards.

---

### Task 1: Research Flue Session History And Compaction

**Files:**
- Create: `docs/architecture/session-context-budget.md`
- Read: Flue docs for sessions, chat, workflows, agent API, and compaction if available
- Read: local `node_modules/@flue/runtime` type definitions and runtime code for session history, prompt usage, and compaction hooks

- [ ] **Step 1: Collect current Flue documentation**

Use web docs and local package files to answer these questions:

```text
How does Flue persist session history?
What does harness.session(id) load or create?
Does session.prompt(...) include full previous history automatically?
Where does PromptResponse.usage come from?
Does Flue expose pre-prompt token counts or only post-response usage?
Does Flue have built-in compaction?
If compaction exists, when is it triggered and can application code configure it?
If compaction does not exist at the app layer, what hook point should GOROMBO own?
```

- [ ] **Step 2: Inspect local runtime types**

Run:

```sh
rg -n "compaction|compact|session|history|usage|PromptResponse|contextWindow|maxTokens" node_modules/@flue node_modules/@earendil-works -S
```

Expected: relevant type definitions or runtime implementation references for sessions and prompt usage.

- [ ] **Step 3: Write the architecture note**

Create `docs/architecture/session-context-budget.md` with:

```markdown
# Session Context Budget

## Flue Session Findings

[Summarize verified Flue session behavior with links or local file references.]

## Budget Inputs

- selected model card
- model context window
- model provider-reported context window
- max output reserve
- current session/history tokens
- current user input tokens
- protocol and instruction tokens
- memory/RAG candidate tokens

## Compaction Decision Points

- warn threshold
- compaction threshold
- hard stop threshold

## Open Questions

[Only include questions that remain genuinely unresolved after research.]
```

- [ ] **Step 4: Verify the note has no stale assumptions**

Run:

```sh
node -e "const fs=require('fs'); const text=fs.readFileSync('docs/architecture/session-context-budget.md','utf8'); const terms=['TB'+'D','TO'+'DO','gu'+'ess','may'+'be','prob'+'ably']; for (const term of terms) if (text.includes(term)) { console.error(term); process.exitCode=1; }"
```

Expected: no matches unless the word appears inside a quoted source excerpt with context.

### Task 2: Add Model Card Lookup For Runtime Budgeting

**Files:**
- Modify: `src/models/cards/index.ts`
- Modify: `src/models/registry.ts`
- Test: `src/tests/models.test.ts`

- [ ] **Step 1: Write the failing tests**

Add tests that describe the desired lookup behavior:

```ts
test('model cards can be resolved from Flue specifier', () => {
  assert.equal(resolveModelCard('ollama-cloud/minimax-m3')?.key, 'minimax-m3-cloud');
  assert.equal(resolveModelCard('ollama-cloud/deepseek-v4-pro')?.key, 'deepseek-v4-pro-cloud');
  assert.equal(resolveModelCard('ollama-cloud/qwen3.5:397b')?.key, 'qwen3-5-cloud');
});

test('unknown model specifier returns undefined', () => {
  assert.equal(resolveModelCard('unknown/model'), undefined);
});
```

- [ ] **Step 2: Run the failing tests**

Run:

```sh
npm test -- --test-name-pattern "model cards can be resolved|unknown model specifier"
```

Expected: TypeScript build fails because `resolveModelCard` does not exist.

- [ ] **Step 3: Implement the lookup**

Export a function shaped like:

```ts
export function resolveModelCard(specifier: string): AgentModelCard | undefined {
  return allModelCards.find((card) => card.specifier === specifier);
}
```

- [ ] **Step 4: Verify tests pass**

Run:

```sh
npm test -- --test-name-pattern "model cards can be resolved|unknown model specifier"
```

Expected: both tests pass.

### Task 3: Add Context Budget Calculation

**Files:**
- Create: `src/session/context-budget.ts`
- Create: `src/tests/context-budget.test.ts`

- [ ] **Step 1: Write failing tests for budget math**

Create tests for:

```ts
test('context budget reserves output tokens from provider-safe context', () => {
  const budget = calculateContextBudget({
    contextWindow: 1_000_000,
    providerReportedContextWindow: 524_288,
    maxOutputTokens: 131_072,
  });

  assert.equal(budget.enforcedContextWindow, 524_288);
  assert.equal(budget.outputReserveTokens, 131_072);
  assert.equal(budget.usableInputTokens, 393_216);
});

test('context budget exposes warning and compaction thresholds', () => {
  const budget = calculateContextBudget({
    contextWindow: 262_144,
    maxOutputTokens: 65_536,
    warningRatio: 0.7,
    compactionRatio: 0.85,
  });

  assert.equal(budget.usableInputTokens, 196_608);
  assert.equal(budget.warningTokens, 137_625);
  assert.equal(budget.compactionTokens, 167_116);
});
```

- [ ] **Step 2: Run the failing tests**

Run:

```sh
npm test -- --test-name-pattern "context budget"
```

Expected: TypeScript build fails because `calculateContextBudget` does not exist.

- [ ] **Step 3: Implement the calculator**

Implement a pure function with no Flue dependency:

```ts
export interface ContextBudgetInput {
  contextWindow: number;
  providerReportedContextWindow?: number;
  guaranteedContextWindow?: number;
  maxOutputTokens: number;
  warningRatio?: number;
  compactionRatio?: number;
}

export interface ContextBudget {
  advertisedContextWindow: number;
  enforcedContextWindow: number;
  outputReserveTokens: number;
  usableInputTokens: number;
  warningTokens: number;
  compactionTokens: number;
}
```

Use provider-reported context first, then guaranteed context, then advertised context.

- [ ] **Step 4: Verify tests pass**

Run:

```sh
npm test -- --test-name-pattern "context budget"
```

Expected: tests pass.

### Task 4: Add Session Budget Reporting To Chat Workflow

**Files:**
- Modify: `src/workflows/chat.ts`
- Modify: `src/tests/chat-workflow.test.ts`
- Test: add or update workflow response tests

- [ ] **Step 1: Write failing tests for response shape**

Extend the chat workflow response type expectation to include:

```ts
contextBudget: {
  modelSpecifier: string;
  enforcedContextWindow: number;
  outputReserveTokens: number;
  usableInputTokens: number;
  warningTokens: number;
  compactionTokens: number;
}
```

- [ ] **Step 2: Run the failing tests**

Run:

```sh
npm test -- --test-name-pattern "chat workflow"
```

Expected: test fails because workflow response does not expose context budget.

- [ ] **Step 3: Implement post-response budget reporting**

After `session.prompt(...)` returns, resolve the response model to a card and calculate budget. If the model is unknown, omit `contextBudget` or return an explicit unknown budget status.

- [ ] **Step 4: Verify tests pass**

Run:

```sh
npm test -- --test-name-pattern "chat workflow"
```

Expected: tests pass.

### Task 5: Define Compaction Trigger Policy

**Files:**
- Modify: `docs/architecture/session-context-budget.md`
- Create: `src/session/compaction-policy.ts`
- Create: `src/tests/compaction-policy.test.ts`

- [ ] **Step 1: Write failing policy tests**

Cover:

```ts
test('compaction policy stays normal below warning threshold', () => {
  assert.equal(evaluateCompaction({ usedTokens: 100, warningTokens: 200, compactionTokens: 300 }).status, 'normal');
});

test('compaction policy warns before compaction threshold', () => {
  assert.equal(evaluateCompaction({ usedTokens: 250, warningTokens: 200, compactionTokens: 300 }).status, 'warn');
});

test('compaction policy requests compaction at threshold', () => {
  assert.equal(evaluateCompaction({ usedTokens: 300, warningTokens: 200, compactionTokens: 300 }).status, 'compact');
});
```

- [ ] **Step 2: Run the failing tests**

Run:

```sh
npm test -- --test-name-pattern "compaction policy"
```

Expected: TypeScript build fails because `evaluateCompaction` does not exist.

- [ ] **Step 3: Implement pure policy function**

Do not call Flue compaction yet. Return a decision object:

```ts
type CompactionStatus = 'normal' | 'warn' | 'compact';
```

- [ ] **Step 4: Document architecture trigger points**

Update `docs/architecture/session-context-budget.md` with:

```text
pre-prompt estimate -> warn/compact decision -> optional compaction -> RAG budget allocation -> prompt
post-response usage -> update budget telemetry
```

- [ ] **Step 5: Verify tests pass**

Run:

```sh
npm test -- --test-name-pattern "compaction policy"
```

Expected: tests pass.

### Task 6: Final Verification And PR Update

**Files:**
- Modify: `README.md` if public instructions change
- Modify: PR body

- [ ] **Step 1: Run full verification**

Run:

```sh
npm run typecheck
npm test
npm run chat:local -- "Reply with exactly: context budget online"
```

Expected:

```text
typecheck passes
all tests pass
CLI returns ollama-cloud/minimax-m3
CLI returns text "context budget online"
```

- [ ] **Step 2: Commit**

Use a detailed commit message:

```sh
git add README.md docs src
git commit -m "Add session context budget planning" \
  -m "Document how Flue session history and model cards will drive token budgets, compaction thresholds, and future RAG allocation." \
  -m "Add a concrete implementation plan for resolving model cards, calculating usable context, reporting workflow budgets, and defining compaction trigger policy."
```

- [ ] **Step 3: Push and update PR**

Run:

```sh
git push origin codex/structure-build
```

Update PR #1 with:

```text
Added documentation and plan for session context budgeting and compaction.
Model cards will drive context limits before RAG is implemented.
```

---

## Self-Review

- Spec coverage: This plan covers Flue research, model card lookup, context budget calculation, workflow reporting, compaction policy, verification, commit, and PR update.
- Placeholder scan: No unresolved placeholder markers are used as work instructions.
- Type consistency: The plan consistently uses model cards, context budget, and compaction policy naming.
