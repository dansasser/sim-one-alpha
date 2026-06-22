# Finish the Coding Worker Product

*Repository:* `sim-one-alpha`
*Path:* `src/workers/coding-worker/`, `src/protocols/`, `src/agents/orchestrator.ts`
*Updated:* 2026-06-14

## Goal

Turn the isolated, tested Phase 2 coding worker into a real hands-off coding agent comparable to Claude Code, Codex, and similar tools. The user must be able to send a natural-language coding task via Telegram or TUI and have the agent triage, implement, test, debug, review, commit, push, and open a PR — with human approval surfaced over the active connector, real-time progress, protocol-driven project rules, and durable project memory.

This plan sits on top of the completed [Phase 2 Execution Plan](../coding-worker/phase2-execution-plan.md). Phase 2 built the skeleton and the loop. This finishes the product.

## Definition of Done

A user sends a message like:

> "Fix the off-by-one bug in `src/utils.ts` and open a PR."

and, without developer hand-holding:

1. The orchestrator loads applicable protocols and delegates to the coding worker.
2. The coding worker consults project-specific coding rules from protocols.
3. It triages the task, reads relevant files, and produces a plan.
4. It generates exact-text edits and applies them atomically.
5. It runs focused and required verification, parses failures, and debugs until passing.
6. It produces a code review; if rejected, it replans and retries.
7. It surfaces an approval request for every mutating side effect (file edit, git commit, git push, GitHub PR create).
8. The user receives the request in Telegram/TUI/web via the generic approval ingress with Approve/Deny buttons and metadata.
9. On approval, it commits, pushes a feature branch, and opens a PR against `main`.
10. Progress events stream back during the run so the user isn't waiting in silence.
11. Project conventions and failed approaches are remembered across tasks.
12. A real-model smoke test proves the loop completes end-to-end on a sample repo.

Until the integration test in step 12 passes with a real model and live approval transport, the coding worker product is **not finished**.

## Guiding Principles

1. **Flue first.** Use Flue-native tool calling, subagents, context budgets, and structured outputs before inventing custom orchestration.
2. **Top-level protocols.** Protocols are a first-class concern. The orchestrator loads them; the coding worker consumes them. Do not bury project rules inside the coding worker workspace.
3. **Approval is an ingress layer, not a connector-specific transport.** The existing approval service and policy are correct. The missing piece is a generic ingress that any connector can poll and write decisions through.
4. **LSP is a gateway, not a parser.** Add language intelligence through a reusable LSP client manager. Start with TypeScript/JavaScript and Python; make every additional language a registry entry plus tests.
5. **Fail-closed and observable.** Every mutating action is approval-gated. Every loop turn, tool call, and failure is logged.
6. **One PR at the end.** All work is integrated into a single parent worktree before opening `codex/coding-worker-finish` against `main`.

## Phase Structure

### Phase 1 — Real Protocols, Top-Level

**Branch:** `codex/coding-worker-finish-protocols`
**Worktree:** `../sim-one-alpha-phase2-finish-protocols`
**Base:** `codex/coding-worker-finish` parent

The protocol layer is now a real SQLite-backed provider. Phase 1 is implemented in PR #23 (`codex/coding-worker-finish-protocols`).

Deliverables:

- [x] Replace `src/protocols/sqlite-protocol-provider-placeholder.ts` with a real SQLite-backed provider using the existing schema in `src/protocols/schema.ts`.
- [x] Add protocol CRUD management:
  - CLI script under `scripts/protocol-admin.mjs` to seed/list/add/remove/enable/disable protocols.
  - Seed the base protocols into the database on first run and backfill missing ones on subsequent runs.
- [x] Update `loadProtocolsTool` in `src/tools/protocol-tool.ts` to use the real provider.
- [x] Pass the loaded `ProtocolBundle` from the orchestrator into the coding worker request context (`CodingWorkerTaskRequest.protocolBundle`).
- [x] Update `src/workers/coding-worker/coding-worker.ts` runtime capabilities and workspace instructions to read and apply protocol directives.
- [x] Extend `ProtocolSelector` and seed protocols to target coding tasks (`workflow: 'coding'`, `task: 'code-change'`).
- [x] Unit tests for provider CRUD, selector matching, backfill behavior, and coding-worker instruction injection.

Verification:

```sh
pnpm run typecheck
pnpm run test:unit
git diff --check
```

### Phase 2 — LSP Code Intelligence Gateway

**Branch:** `codex/coding-worker-finish-lsp`
**Worktree:** `../sim-one-alpha-phase2-finish-lsp`
**Base:** parent with Phase 1 merged

Add real language-server intelligence through a pluggable LSP gateway. The custom AST parsers from Phase 2.7 remain as fallbacks; LSP becomes the primary path where available.

Deliverables:

- [ ] Create `src/workers/coding-worker/tools/code-intelligence/lsp/` module:
  - `LspClientManager` — start, reuse, and stop LSP server processes per language.
  - `LspLanguageServerRegistry` — map file extensions and language IDs to server commands.
  - JSON-RPC client with request/response and notification handling.
- [ ] Implement the first two language servers:
  - **TypeScript/JavaScript** via `typescript-language-server`.
  - **Python** via `python-lsp-server` or `pyright`.
- [ ] Standardized LSP tool interface exposed to the coding worker model:
  - `lsp_initialize`
  - `lsp_find_references`
  - `lsp_go_to_definition`
  - `lsp_hover`
  - `lsp_document_symbols`
  - `lsp_workspace_symbol`
  - `lsp_prepare_rename`
- [ ] Register LSP tools in the coding worker profile via `createCodingRepoTools` or a dedicated intelligence tool factory.
- [ ] Graceful fallback to existing custom parsers when no LSP server is installed or the server crashes.
- [ ] Unit tests with mocked LSP JSON-RPC responses.
- [ ] Documentation for adding a new language server: one registry entry + one test fixture.

Verification:

```sh
pnpm run typecheck
pnpm run test:unit
git diff --check
```

### Phase 3 — Approval Ingress

**Branch:** `codex/coding-worker-finish-approval`
**Worktree:** `../sim-one-alpha-phase2-finish-approval`
**Base:** parent with Phases 1 and 2 merged

This is the critical production blocker. The approval service persists requests to `.gorombo-approvals/approvals.json`, but nothing surfaces them to a real user. The connector layer should not need to know about the coding worker's internal approval storage. Build a generic **approval ingress** that any connector can poll or subscribe to, and a matching **approval decision ingress** that connectors write decisions into.

Deliverables:

- [ ] Add `src/ingress/approval-ingress.ts` exposing:
  - `listPendingApprovals(filter: { taskId?, actorId?, conversationId?, connector? })`
  - `getApprovalRequest(requestId)`
  - `recordApprovalDecision(input)` — validates the principal and writes through `CodingApprovalService.recordDecision`.
- [ ] Add `src/ingress/approval-connector-binding.ts` that binds pending approvals to a connector+conversation:
  - The coding worker emits `coding.approval.requested` events with the task's `actorId`, `conversationId`, and originating `connector`.
  - The ingress records these bindings so a connector can fetch only the approvals meant for its user/channel.
- [ ] Add HTTP routes in `src/routes/approval-routes.ts`:
  - `GET /api/approvals/pending` — list pending approvals for the authenticated session/connector.
  - `GET /api/approvals/:requestId` — get one approval request.
  - `POST /api/approvals/:requestId/decision` — record approve/deny with principal.
  - Secured by `requireApiSecret` or session auth.
- [ ] Telegram connector integration:
  - Poll the approval ingress for pending approvals tied to the Telegram `actorId`/`conversationId`.
  - Render an inline message with Approve/Deny buttons and metadata: action type, summary, target, risk, and a link/diff preview where possible.
  - On button press, POST the decision to the approval ingress.
- [ ] TUI/web connector integration:
  - Use the same HTTP routes from the web client.
  - Render approval cards in the TUI or web UI.
- [ ] Approval request expiration with user notification surfaced through the originating connector.
- [ ] Denied-request handling: coding worker replans or aborts and reports back.
- [ ] Unit tests for the ingress service; integration test proving a fake connector decision unblocks a git commit.

Verification:

```sh
pnpm run typecheck
pnpm run test:unit
git diff --check
```

### Phase 4 — Real Model Smoke Test and Failure-Mode Hardening

**Branch:** `codex/coding-worker-finish-smoke`
**Worktree:** `../sim-one-alpha-phase2-finish-smoke`
**Base:** parent with Phases 1–3 merged

The existing E2E test uses `createEndToEndDelegate()` — a fake subagent that always emits correct structured output. Run the loop against a real model and harden against real failure modes.

Deliverables:

- [ ] Add a `smoke-test` harness that runs the coding worker against a temporary git repo using the actual configured model card.
- [ ] Capture and categorize real failure modes:
  - Hallucinated tool names.
  - Malformed edits.
  - Infinite or long loops.
  - Context budget exhaustion.
- [ ] Add guardrails:
  - Tool-name allowlist and validation.
  - Edit schema validation before application.
  - Hard loop iteration ceiling with graceful exit.
  - Malformed-output retry with a simplified prompt.
- [ ] Add observability: log each loop turn, subagent call, tool invocation, and result.
- [ ] A real-model smoke test passes on a sample bug-fix task.

Verification:

```sh
pnpm run typecheck
pnpm run test:unit
pnpm run test
git diff --check
```

### Phase 5 — Streaming Progress

**Branch:** `codex/coding-worker-finish-streaming`
**Worktree:** `../sim-one-alpha-phase2-finish-streaming`
**Base:** parent with Phases 1–4 merged

Progress events are emitted but currently batched and returned at the end. A user watching a long coding task sees nothing until it finishes or blocks.

Deliverables:

- [ ] Replace the in-memory batch reporter with an event stream the orchestrator can consume incrementally.
- [ ] Wire the orchestrator to forward progress events to the active connector (Telegram/TUI/web).
- [ ] Telegram strategy: edit an existing message or send follow-up messages with rate limiting.
- [ ] Include checkpoint events: plan created, edits applied, verification running, approval requested, approval received, PR opened.
- [ ] Unit tests for progress event serialization and connector forwarding.

Verification:

```sh
pnpm run typecheck
pnpm run test:unit
git diff --check
```

### Phase 6 — Error Recovery and Retry

**Branch:** `codex/coding-worker-finish-retry`
**Worktree:** `../sim-one-alpha-phase2-finish-retry`
**Base:** parent with Phases 1–5 merged

Transient failures currently have minimal retry/backoff.

Deliverables:

- [ ] Add retry/backoff wrappers for:
  - `gh` CLI network errors and rate limits.
  - Sandbox command timeouts.
  - Model API transient failures (rate limit, timeout).
- [ ] Distinguish transient vs permanent failures in the loop.
- [ ] Surface provider failures to the user with context.
- [ ] Unit tests with mocked flaky dependencies.

Verification:

```sh
pnpm run typecheck
pnpm run test:unit
git diff --check
```

### Phase 7 — Durable Project Memory

**Branch:** `codex/coding-worker-finish-memory`
**Worktree:** `../sim-one-alpha-phase2-finish-memory`
**Base:** parent with Phases 1–6 merged

Each task starts fresh. Remember conventions, decisions, and failed approaches across coding sessions.

Deliverables:

- [ ] Add a project-memory provider keyed by `projectId` and `repoPath`.
- [ ] Persist memory records:
  - Coding conventions observed by the agent.
  - User-approved/denied decisions with reasons.
  - Failed approaches and their error signatures.
- [ ] Inject relevant memory into coding worker instructions and triage context.
- [ ] Unit tests for memory CRUD and relevance retrieval.

Verification:

```sh
pnpm run typecheck
pnpm run test:unit
git diff --check
```

### Phase 8 — Final Integration and Production Hardening

**Branch:** `codex/coding-worker-finish-integration`
**Worktree:** `../sim-one-alpha-phase2-finish-integration`
**Base:** parent with Phases 1–7 merged

Integrate everything and prove the full definition of done.

Deliverables:

- [ ] End-to-end integration test:
  - Telegram message → orchestrator → coding worker.
  - Approval request surfaced through the generic approval ingress to a Telegram connector.
  - Simulated user approval via the approval ingress.
  - Commit, push, PR opened.
  - Progress updates streamed.
- [ ] Real-model smoke test passes on a sample repo.
- [ ] Update all coding-worker workspace files and docs to reflect production wiring.
- [ ] Update `docs/superpowers/plans/coding-worker/` with a completion note.
- [ ] Run full verification:

```sh
pnpm run typecheck
pnpm run test:unit
pnpm run test
git diff --check
```

- [ ] Merge into parent, push `codex/coding-worker-finish`, and open a single PR against `main`.

## Worktree Strategy

One parent worktree, sequential child PRs merged into it, single final PR.

- **Parent worktree:** `/opt/ai/sim-one-alpha-phase2-finish` on `codex/coding-worker-finish`
- **Child worktrees:** `/opt/ai/sim-one-alpha-phase2-finish-<phase>` on `codex/coding-worker-finish-<phase>`

Lifecycle:

1. Create the parent from `main`.
2. For each phase, create a child worktree from the parent branch.
3. Do the work in the child.
4. Merge the child back into the parent and resolve conflicts in the parent worktree.
5. Run typecheck, unit tests, and `git diff --check` in the parent.
6. Delete the child worktree.
7. After Phase 8, push the parent branch and open one PR.

No PR is opened until the parent is clean and all tests pass.

## Verification Discipline

Before declaring any phase complete or the parent PR ready:

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

- Rewriting the Phase 2 loop or subagents. They are assumed complete.
- Multi-tenant protocol administration UI.
- Billing, quotas, or usage limits.
- IDE extension or VS Code integration.
- Advanced refactoring tools beyond the initial LSP tool surface.

## Dependencies and Risks

- **Node 22:** Already installed via `nvm`. Verify by sourcing `nvm` before running `pnpm`.
- **LSP server binaries:** `typescript-language-server` and a Python language server must be installed for real LSP tests; mocked tests do not require them.
- **Telegram bot token:** The Telegram connector integration requires the bot token and must poll the generic approval ingress.
- **GitHub token:** The smoke test and integration test require `GH_TOKEN` or `GITHUB_TOKEN` for real PR creation; mock PR creation is acceptable for the automated test suite.
- **Model availability:** The real-model smoke test requires a configured and reachable model card. Provide a fallback that skips the test if no model is available, but fail the phase if the test is skipped repeatedly.
