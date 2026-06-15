# cubic-dev-ai fixes — PRs #23, #25, #26

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Address the 31 unresolved issues identified by cubic-dev-ai in the merged PRs #23, #25, and #26, organized into logical PR-sized chunks with focused commits.

**Architecture:** Apply fixes on the worktree branch `codex/cubic-fixes-pr-23-25-26` checked out at `/opt/ai/astro-flue-agent-cubic-fixes`. Each PR's fixes should land as one or more dedicated commits so the final PR groups changes by addressed PR. Do not modify the original merge commits; this is a follow-up fix branch off `main`.

**Tech Stack:** TypeScript, Flue, SQLite, LanceDB, LSP, Vitest/node:test, pnpm.

---

## Global Preconditions

- [ ] Confirm worktree branch is `codex/cubic-fixes-pr-23-25-26` at `/opt/ai/astro-flue-agent-cubic-fixes`.
- [ ] Run `pnpm install` to ensure dependencies are present.
- [ ] Run baseline checks: `pnpm run typecheck`, `pnpm run build`, `pnpm test` (or equivalent scripts from `package.json`).
- [ ] Record baseline results.

---

## PR #23 — Protocol System Fixes

### Task 1: Preserve user overrides during `protocols:seed`

**Files:**
- Modify: `scripts/protocol-admin.mjs:206`

- [ ] **Step 1:** Open `scripts/protocol-admin.mjs` and locate the seeding SQL at line 206.
- [ ] **Step 2:** Change the seed `INSERT` to `INSERT OR IGNORE` so existing rows (including user overrides) are not overwritten.
- [ ] **Step 3:** Add a regression test or update an existing seed test to verify rerunning `protocols:seed` does not overwrite a user override.
- [ ] **Step 4:** Run the relevant test.
- [ ] **Step 5:** Commit with message: `fix(protocol-admin): use INSERT OR IGNORE for protocol seeding to preserve user overrides (PR #23)`.

### Task 2: Prevent disabling base protocols

**Files:**
- Modify: `scripts/protocol-admin.mjs:302`

- [ ] **Step 1:** Locate the `protocols:disable` command handler around line 302.
- [ ] **Step 2:** Add a guard that rejects `id` values starting with or matching base protocol IDs (e.g., `global.protocols-first`, base protocols). Base IDs must remain enabled for governance.
- [ ] **Step 3:** Add a test asserting that disabling a base protocol is rejected.
- [ ] **Step 4:** Run the relevant test.
- [ ] **Step 5:** Commit with message: `fix(protocol-admin): block disabling base protocols (PR #23)`.

### Task 3: Make `protocolBundle` directives actually enforced in coding-worker loop

**Files:**
- Modify: `src/workers/coding-worker/workflow/loop.ts:96`
- Inspect: `src/workers/coding-worker/runtime-capabilities.ts`, `src/workers/coding-worker/workspace/AGENTS.md`

- [ ] **Step 1:** Verify how `protocolBundle` is received in `runCodingWorkerLoop`.
- [ ] **Step 2:** Replace or augment the log-only usage so that `protocolBundle.protocols[].rules` are parsed and applied to loop behavior (e.g., before planning, tool selection, response).
- [ ] **Step 3:** Emit a public progress event summarizing applied directives (without exposing raw rule text).
- [ ] **Step 4:** Add/update a test that asserts directives change loop behavior.
- [ ] **Step 5:** Run the relevant test.
- [ ] **Step 6:** Commit with message: `fix(coding-worker): enforce protocolBundle directives instead of only logging them (PR #23)`.

### Task 4: Stop base-protocol seeding from overwriting user overrides

**Files:**
- Modify: `src/protocols/sqlite-protocol-provider.ts:58`

- [ ] **Step 1:** Locate `seedBaseProtocols()` around line 58.
- [ ] **Step 2:** Change the seed logic to only insert protocols that are missing (`INSERT OR IGNORE` or equivalent existence check), preserving any user override row with the same ID.
- [ ] **Step 3:** Add a regression test: create provider, override a base protocol, close/reopen provider, assert override survives.
- [ ] **Step 4:** Run the relevant test.
- [ ] **Step 5:** Commit with message: `fix(protocol-provider): preserve user overrides when seeding base protocols (PR #23)`.

### Task 5: Scope `setEnabled` to user protocols

**Files:**
- Modify: `src/protocols/sqlite-protocol-provider.ts:201`

- [ ] **Step 1:** Locate `setEnabled()` around line 201.
- [ ] **Step 2:** Update the SQL `UPDATE` to include `AND scope = 'user'` (or equivalent) so base protocols cannot be mutated.
- [ ] **Step 3:** Add a test asserting that enabling/disabling a base protocol is rejected or no-op.
- [ ] **Step 4:** Run the relevant test.
- [ ] **Step 5:** Commit with message: `fix(protocol-provider): scope setEnabled to user protocols only (PR #23)`.

---

## PR #25 — LSP / Code-Intelligence Fixes

### Task 6: Fix JSON-RPC framing for non-ASCII payloads

**Files:**
- Modify: `src/workers/coding-worker/tools/code-intelligence/lsp/lsp-json-rpc.ts:28`

- [ ] **Step 1:** Inspect the current framing/decoding logic.
- [ ] **Step 2:** Refactor to treat incoming data as bytes (Buffer/Uint8Array) and decode complete messages with a byte-aware Content-Length parser.
- [ ] **Step 3:** Add a test that sends a JSON-RPC message containing multi-byte Unicode characters and verifies correct parsing.
- [ ] **Step 4:** Run the relevant test.
- [ ] **Step 5:** Commit with message: `fix(lsp): handle non-ASCII payloads in JSON-RPC framing (PR #25)`.

### Task 7: Add bare `Range` variant to `LspPrepareRenameResult`

**Files:**
- Modify: `src/workers/coding-worker/tools/code-intelligence/lsp/lsp-types.ts:86`

- [ ] **Step 1:** Locate `LspPrepareRenameResult` type definition.
- [ ] **Step 2:** Add the bare `Range` variant to the union (per LSP spec).
- [ ] **Step 3:** Update any normalization code that handles `prepareRename` results to accept the bare `Range`.
- [ ] **Step 4:** Add a type-level and/or runtime test for bare `Range` responses.
- [ ] **Step 5:** Commit with message: `fix(lsp): support bare Range in LspPrepareRenameResult (PR #25)`.

### Task 8: Fix malformed Unix LSP server discovery

**Files:**
- Modify: `src/workers/coding-worker/tools/code-intelligence/lsp/lsp-server-registry.ts:12`

- [ ] **Step 1:** Locate the discovery call.
- [ ] **Step 2:** Fix the `sh -c` invocation so it passes the target command to `command -v` correctly.
- [ ] **Step 3:** Add a unit test that mocks `execFile`/`exec` and asserts the resolved command path.
- [ ] **Step 4:** Run the relevant test.
- [ ] **Step 5:** Commit with message: `fix(lsp): correct Unix language server discovery command (PR #25)`.

### Task 9: Allow LSP tools to work without an injected sandbox

**Files:**
- Modify: `src/workers/coding-worker/tools/code-intelligence/code-intelligence-tools.ts:85`

- [ ] **Step 1:** Identify where LSP tools are gated on `options.sandbox`.
- [ ] **Step 2:** Refactor so LSP is attempted first; only fall back to AST when sandbox is unavailable **and** LSP cannot be initialized.
- [ ] **Step 3:** Add a test that exercises the no-sandbox path and confirms LSP is still used.
- [ ] **Step 4:** Run the relevant test.
- [ ] **Step 5:** Commit with message: `fix(code-intelligence): use LSP-first behavior even without injected sandbox (PR #25)`.

### Task 10: Return full by-name LSP symbol results

**Files:**
- Modify: `src/workers/coding-worker/tools/code-intelligence/code-intelligence-tools.ts:443`

- [ ] **Step 1:** Locate the `.find` call that returns a single symbol.
- [ ] **Step 2:** Replace with `.filter` (or equivalent) to return all matching symbols.
- [ ] **Step 3:** Update downstream consumers to handle an array of results.
- [ ] **Step 4:** Add a test with duplicate symbol names.
- [ ] **Step 5:** Commit with message: `fix(code-intelligence): return all matching LSP symbols instead of first (PR #25)`.

### Task 11: Track LSP document open/close lifecycle

**Files:**
- Modify: `src/workers/coding-worker/tools/code-intelligence/lsp/lsp-client-manager.ts:122`

- [ ] **Step 1:** Add an internal map of opened document URIs.
- [ ] **Step 2:** In `openDocument`, only send `textDocument/didOpen` if the URI is not already tracked; update tracking on close/change.
- [ ] **Step 3:** Add a test verifying duplicate opens are suppressed.
- [ ] **Step 4:** Commit with message: `fix(lsp): avoid duplicate textDocument/didOpen for already-open documents (PR #25)`.

### Task 12: Send LSP shutdown as a request

**Files:**
- Modify: `src/workers/coding-worker/tools/code-intelligence/lsp/lsp-client-manager.ts:136`

- [ ] **Step 1:** Locate the `shutdown` send call.
- [ ] **Step 2:** Change it from a notification to a request and await the response before `exit`.
- [ ] **Step 3:** Add a test asserting shutdown request/response sequence.
- [ ] **Step 4:** Commit with message: `fix(lsp): send shutdown as request and await response (PR #25)`.

### Task 13: Build file URIs safely

**Files:**
- Modify: `src/workers/coding-worker/tools/code-intelligence/lsp/lsp-client-manager.ts:224`

- [ ] **Step 1:** Replace string-concatenated URIs with `pathToFileURL` from `node:url` (or equivalent cross-platform helper).
- [ ] **Step 2:** Add tests for Windows-style paths and paths with special characters.
- [ ] **Step 3:** Commit with message: `fix(lsp): build file URIs safely across platforms (PR #25)`.

---

## PR #26 — RAG / Memory / Model Registry Fixes

### Task 14: Exclude embedding-only cards from chat model selection

**Files:**
- Modify: `src/models/registry.ts:6`

- [ ] **Step 1:** Locate the primary/backup model selection logic.
- [ ] **Step 2:** Add a role/capability check so only chat-capable cards can be selected as `models.primary` or `models.backup`.
- [ ] **Step 3:** Add a test that an embedding-only card cannot be selected.
- [ ] **Step 4:** Commit with message: `fix(models): prevent embedding-only cards from chat model selection (PR #26)`.

### Task 15: Purge removed/rewritten chunks during background reindex

**Files:**
- Modify: `src/rag/indexers/background-indexer.ts:50`

- [ ] **Step 1:** Identify the upsert-only reindex path.
- [ ] **Step 2:** Before upserting, delete existing chunks for the document/project being reindexed, then insert the new chunks.
- [ ] **Step 3:** Ensure deletion and insertion are wrapped in a transaction where possible.
- [ ] **Step 4:** Add a test that verifies stale chunks are removed.
- [ ] **Step 5:** Commit with message: `fix(rag): purge stale chunks during background reindex (PR #26)`.

### Task 16: Derive knowledge write scope from trusted context, not model-provided eventId

**Files:**
- Modify: `src/tools/knowledge-tool.ts:22`

- [ ] **Step 1:** Locate where `eventId` from the model determines write scope.
- [ ] **Step 2:** Refactor so the trusted runtime context (actor/conversation IDs) scopes the write; ignore or validate the model-provided `eventId`.
- [ ] **Step 3:** Add a test that attempts to write using another event's ID and is rejected.
- [ ] **Step 4:** Commit with message: `fix(knowledge): scope writes to trusted actor/conversation context (PR #26)`.

### Task 17: Make LanceDB upsert atomic

**Files:**
- Modify: `src/rag/vector/lance-db-store.ts:64`

- [ ] **Step 1:** Refactor upsert to add new rows before deleting old rows, or use a single atomic operation if the LanceDB SDK supports it.
- [ ] **Step 2:** On failure, ensure old rows are not lost.
- [ ] **Step 3:** Add a test simulating a write failure mid-upsert.
- [ ] **Step 4:** Commit with message: `fix(lance-db): make vector upsert atomic and recoverable (PR #26)`.

### Task 18: Make LanceDB table creation idempotent

**Files:**
- Modify: `src/rag/vector/lance-db-store.ts:130`

- [ ] **Step 1:** Wrap `createTable` in a check for existing table; if it exists, open it instead.
- [ ] **Step 2:** Add a concurrency test with multiple simultaneous first writes.
- [ ] **Step 3:** Commit with message: `fix(lance-db): make table creation idempotent under concurrent first writes (PR #26)`.

### Task 19: Optimize chunk line-range computation

**Files:**
- Modify: `src/rag/indexers/chunker.ts:50`

- [ ] **Step 1:** Refactor line-range computation to scan the file once and track cumulative offsets.
- [ ] **Step 2:** Add a benchmark or test on a large file to confirm linear behavior.
- [ ] **Step 3:** Commit with message: `perf(chunker): compute chunk line ranges in a single pass (PR #26)`.

### Task 20: Stabilize chunk IDs across reindexes

**Files:**
- Modify: `src/rag/indexers/chunker.ts:53`

- [ ] **Step 1:** Replace index-based chunk IDs with content-derived or source-location-derived IDs (e.g., hash of file path + start/end offsets).
- [ ] **Step 2:** Add a test that edits a file and confirms unrelated chunk IDs remain stable.
- [ ] **Step 3:** Commit with message: `fix(chunker): use stable chunk IDs across reindexes (PR #26)`.

### Task 21: Await vector deletion in session cleanup

**Files:**
- Modify: `src/session/session-database.ts:942`

- [ ] **Step 1:** Locate `deleteFlueSession()` and its vector deletion call.
- [ ] **Step 2:** Refactor to `await` the vector deletion before returning.
- [ ] **Step 3:** Add a test asserting vectors are removed before reindex proceeds.
- [ ] **Step 4:** Commit with message: `fix(session): await vector deletion during session cleanup (PR #26)`.

### Task 22: Make session persistence indexing fire-and-forget

**Files:**
- Modify: `src/session/session-persistence.ts:114`

- [ ] **Step 1:** Move embedding/vector indexing off the synchronous save path.
- [ ] **Step 2:** Trigger indexing asynchronously with error handling/logging.
- [ ] **Step 3:** Add a test verifying save latency is not blocked by embedding timeout.
- [ ] **Step 4:** Commit with message: `fix(session): make background indexing fire-and-forget to avoid blocking saves (PR #26)`.

### Task 23: Decouple knowledge route from tool module

**Files:**
- Modify: `src/routes/knowledge.ts:7`
- Create/Modify: shared persistence service module

- [ ] **Step 1:** Extract shared knowledge persistence logic into a service module (e.g., `src/services/knowledge-service.ts`).
- [ ] **Step 2:** Update `src/tools/knowledge-tool.ts` and `src/routes/knowledge.ts` to import from the service module.
- [ ] **Step 3:** Run tests for both route and tool.
- [ ] **Step 4:** Commit with message: `refactor(knowledge): move shared persistence logic out of tool module (PR #26)`.

### Task 24: Persist knowledge event only after successful write

**Files:**
- Modify: `src/routes/knowledge.ts:47`

- [ ] **Step 1:** Reorder logic so `store.add` is awaited before the event is persisted.
- [ ] **Step 2:** Add a test that a failed write does not leave an audit event.
- [ ] **Step 3:** Commit with message: `fix(knowledge): persist event only after successful knowledge write (PR #26)`.

### Task 25: Respect `options.env` in embedding client credential resolution

**Files:**
- Modify: `src/rag/embeddings.ts:60`

- [ ] **Step 1:** Update credential/base URL resolution to prefer `options.env` when provided.
- [ ] **Step 2:** Add a test that passes custom env and asserts it is used.
- [ ] **Step 3:** Commit with message: `fix(embeddings): honor options.env for API key and base URL (PR #26)`.

### Task 26: Allow Ollama embeddings when OLLAMA_LOCAL_API_KEY is unset

**Files:**
- Modify: `src/rag/embeddings.ts:61`

- [ ] **Step 1:** Remove or relax the check that blocks Ollama embeddings without `OLLAMA_LOCAL_API_KEY`.
- [ ] **Step 2:** Add a test for local Ollama without the env var.
- [ ] **Step 3:** Commit with message: `fix(embeddings): allow local Ollama embeddings without explicit API key (PR #26)`.

### Task 27: Fix vector scope filter field mapping

**Files:**
- Modify: `src/memory/memory-provider.ts:122`

- [ ] **Step 1:** Locate the filter mapping `conversationId` to `actor_id`.
- ] **Step 2:** Correct the field mapping so conversationId filters the conversation field and actorId filters the actor field.
- [ ] **Step 3:** Add a test for each filter.
- [ ] **Step 4:** Commit with message: `fix(memory): correct vector scope filter field mapping (PR #26)`.

### Task 28: Persist actor/conversation IDs where knowledge-store list() reads them

**Files:**
- Modify: `src/rag/knowledge-store.ts:70`

- [ ] **Step 1:** Ensure actor/conversation IDs are stored on knowledge records in the same shape that `list()` queries.
- [ ] **Step 2:** Add a test for `list({ actorId })` and `list({ conversationId })`.
- [ ] **Step 3:** Commit with message: `fix(knowledge-store): persist and query actor/conversation IDs correctly (PR #26)`.

### Task 29: Apply vector filters before truncating in knowledge-store list()

**Files:**
- Modify: `src/rag/knowledge-store.ts:95`

- [ ] **Step 1:** Refactor `list()` to pass filters into the vector query, or apply JS filters before truncation.
- [ ] **Step 2:** Add a test with >100 records where filters should reduce result set.
- [ ] **Step 3:** Commit with message: `fix(knowledge-store): apply filters before truncating list results (PR #26)`.

### Task 30: Early return in document-index-provider when limit is zero

**Files:**
- Modify: `src/rag/document-index-provider.ts:31`

- [ ] **Step 1:** Add an early return before embedding/vector query when computed `limit` is zero.
- [ ] **Step 2:** Add a test for `limit: 0`.
- [ ] **Step 3:** Commit with message: `fix(document-index): skip embedding/query when limit is zero (PR #26)`.

### Task 31: Scope knowledge-base retrieval by actor/conversation

**Files:**
- Modify: `src/rag/document-index-provider.ts:38`

- [ ] **Step 1:** Add actor/conversation filters when querying the `knowledge_base` collection.
- [ ] **Step 2:** Add a test that cross-user knowledge is not returned.
- [ ] **Step 3:** Commit with message: `fix(document-index): scope knowledge-base retrieval by actor/conversation (PR #26)`.

---

## Final Verification

- [ ] Run full test suite: `pnpm test`
- [ ] Run typecheck: `pnpm run typecheck`
- [ ] Run build: `pnpm run build`
- [ ] Fix any failures.

## Final Commit / PR

- [ ] Push branch `codex/cubic-fixes-pr-23-25-26`.
- [ ] Open a draft PR against `main` with a description listing each addressed PR and the fixes applied.
- [ ] Mark PR as ready for review once CI passes.
