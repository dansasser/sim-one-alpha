# PR #31 Follow-up Review Checklist

Source reviews: Code Rabbit + cubic-dev-ai on `codex/cubic-fixes-pr-23-25-26` (PR #31).

**Instruction:** Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate with tests.

---

## Code Rabbit Findings

### 1. `src/rag/document-index-provider.ts` — enforce knowledge_base scoping

- [x] Verify line 42-55: `knowledge_base` collection filtering.
- [x] If valid: add validation that when `collection === 'knowledge_base'`, at least one scope filter (`actor_id` or `conversation_id`) is present.
- [x] Decide behavior: skip collection in results OR throw before `vectorStore.search`.
- [x] Add/update test for unscoped `knowledge_base` query.
- [x] Run related tests.

### 2. `src/rag/indexers/background-indexer.ts` — purge stale vectors correctly

- [x] Verify line 39-52: current delete/search logic.
- [x] If valid: add `listIds(collection)` to `VectorStore` interface.
- [x] Implement `listIds` in `src/rag/vector/lance-db-store.ts`.
- [x] Refactor background-indexer to use `listIds()` for full stale-id discovery (no 100k cap, handles empty collections).
- [x] Add/update tests for empty collection purge and large collection purge.
- [x] Run related tests.

### 3. `src/rag/knowledge-store.ts` — fix source filter field

- [x] Verify line 91-100: `source` filter mapping.
- [x] If valid: change filter from top-level `source` to `metadata.source`.
- [x] Add/update test for `list({ source })`.
- [x] Run related tests.

### 4. `src/session/session-database.ts` — fix pending delete race

- [x] Verify line 964-969: `deleteSessionMemoryVectorsFinished`.
- [x] If valid: save reference to `pendingVectorDeletes` before await, only clear if it still equals the awaited promise.
- [x] Add/update test for concurrent `deleteFlueSession` calls.
- [x] Run related tests.

### 5. `src/workers/coding-worker/workflow/loop.ts` — block on missing verification

- [x] Verify line 372-380: `verificationRequired` handling.
- [x] If valid: add blocking logic so task cannot complete when verification is required but no commands registered.
- [x] Options: throw, return early, or set blocking flag.
- [x] Add/update test that task fails/blocks without verification commands.
- [x] Run related tests.

### 6. `CUBIC_PROMPTS.md` — move to docs/

- [x] Verify file location at repository root.
- [x] If valid: move to `docs/CUBIC_PROMPTS.md` (or `docs/superpowers/prompts/CUBIC_PROMPTS.md` if that hierarchy exists).
- [x] Update any internal references.
- [x] Run tests to ensure no breakage.

### 7. `src/rag/embeddings.ts` — pass env to single embed

- [x] Verify line 27-33: `embed()` vs `embedBatch()`.
- [x] If valid: pass `env` to `embedBatchInternal` in `embed()`.
- [x] Add/update test for `createEmbeddingClient({ env }).embed(...)`.
- [x] Run related tests.

### 8. `src/workers/coding-worker/tools/code-intelligence/code-intelligence-tools.ts` — remove dead lspTools

- [x] Verify line 83-89: `lspTools` variable usage.
- [x] If valid: remove `createLspTools` call and `lspTools` assignment.
- [x] Run related tests.

### 9. `src/workers/coding-worker/tools/code-intelligence/lsp/lsp-client-manager.ts` — graceful idle eviction

- [x] Verify line 221-230: shutdown timer callback.
- [x] If valid: replace direct `client.client.dispose()` with shutdown request + exit notification + dispose sequence.
- [x] Add/update test for idle eviction shutdown sequence.
- [x] Run related tests.

### 10. `src/workers/coding-worker/tools/code-intelligence/lsp/lsp-server-registry.ts` — fix Unix command discovery

- [x] Verify line 8-16: `execFileAsync('command', ...)`.
- [x] If valid: replace with `execFileAsync('sh', ['-c', 'command -v ' + command])` or `execFileAsync('which', [command])`.
- [x] Add/update test for Unix discovery.
- [x] Run related tests.

### 11. `src/workers/coding-worker/tools/code-intelligence/lsp/lsp-tools.ts` — decide sandbox requirement

- [x] Verify line 74-97: `readFileForDidOpen` fallback and `withDocument` `getSandbox()`.
- [x] Decide design: sandbox always required, or sandbox optional.
- [x] If sandbox always required: remove unreachable `node:fs/promises` fallback and update JSDoc.
- [x] If sandbox optional: restructure `withDocument` to use `path.resolve()` when sandbox absent.
- [x] Add/update test matching chosen design.
- [x] Run related tests.

---

## cubic-dev-ai Findings

### 12. `lsp-server-registry.ts` — Unix `command` builtin (duplicate of #10)

- [x] Same as Code Rabbit #10 above. Verify once, fix once.

### 13. `src/session/session-persistence.ts` — fire-and-forget delete/upsert race

- [x] Verify line 114: `recordFlueSession` fire-and-forget after save.
- [x] If valid: ensure deleted session memory cannot be reintroduced by async upsert.
- [x] Potential fix: gate or serialize save-time indexing against in-flight deletes.
- [x] Add/update test for delete-then-save race.
- [x] Run related tests.

### 14. `src/protocols/sqlite-protocol-provider.ts` — base protocol updates won't propagate

- [x] Verify line 55: `INSERT OR IGNORE` in `seedBaseProtocols()`.
- [x] If valid: decide how to propagate updated base-protocol releases to existing DBs.
- [x] Options: versioned seeds, UPDATE existing seed rows, or delete stale seeds and re-insert.
- [x] Add/update test that new base protocol release updates existing seed rows.
- [x] Run related tests.

### 15. `src/workers/coding-worker/workflow/loop.ts` — verification not enforced (duplicate of #5)

- [x] Same as Code Rabbit #5 above. Verify once, fix once.

### 16. `lsp-client-manager.ts` — global didOpen dedupe not reset on eviction

- [x] Verify line 124: `openDocuments` global set.
- [x] If valid: clear tracked URIs when a client is evicted/closed so reopened clients send required `didOpen`.
- [x] Add/update test for re-open after eviction.
- [x] Run related tests.

### 17. `background-indexer.ts` — empty reindex path no-op (duplicate of #2)

- [x] Same as Code Rabbit #2 above. Verify once, fix once.

### 18. `background-indexer.ts` — 1D dummy query incompatible with stored dimension

- [x] Verify line 46: `new Array(1).fill(0)` search for stale lookup.
- [x] If valid: use a query vector whose dimension matches the stored embeddings, or use `listIds()` instead.
- [x] Same fix as #2 likely covers this.
- [x] Add/update test.
- [x] Run related tests.

### 19. `src/session/session-database.ts` — pending delete queue race (duplicate of #4)

- [x] Same as Code Rabbit #4 above. Verify once, fix once.

### 20. `src/rag/document-index-provider.ts` — empty strings fail open (duplicate of #1)

- [x] Verify line 44: scope filter handling for empty strings.
- [x] If valid: apply scope filters unconditionally or reject empty scope.
- [x] Same fix as #1 likely covers this.
- [x] Add/update test.
- [x] Run related tests.

### 21. `code-intelligence-tools.ts` — rebuild LSP tools per query

- [x] Verify line 132: `createLspTools` factory in each symbol query.
- [x] If valid: memoize one sandbox-bound LSP toolset per `createCodingCodeIntelligenceTools` instance and reuse.
- [x] Add/update test for caching/reuse.
- [x] Run related tests.

### 22. `code-intelligence-tools.ts` — returns after first matching symbol

- [x] Verify line 509: early return in symbol aggregation.
- [x] If valid: aggregate results across all `matchingSymbols` and candidate files before returning.
- [x] Add/update test with duplicate symbol names.
- [x] Run related tests.

### 23. `docs/superpowers/plans/cubic-fixes-pr-23-25-26.md` — malformed checkbox

- [x] Verify line 305: broken checkbox syntax.
- [x] If valid: fix markdown checkbox.
- [x] No test needed.

### 24. `lsp-tools.ts` — no-sandbox support broken for document-based tools (related to #11)

- [x] Verify line 81: `getSandbox()` throws before fallback.
- [x] If valid: implement chosen design from #11 (sandbox required OR optional).
- [x] Add/update test.
- [x] Run related tests.

### 25. `lsp-json-rpc.ts` — retained large consumed buffers

- [x] Verify line 99: `this.rawBuffer = this.rawBuffer.subarray(...)`.
- [x] If valid: assign `Buffer.alloc(0)` when fully consumed to release prior buffer.
- [x] Add/update test for buffer release behavior.
- [x] Run related tests.

### 26. `knowledge-store.ts` — source filter wrong column (duplicate of #3)

- [x] Same as Code Rabbit #3 above. Verify once, fix once.

### 27. `embeddings.ts` — env not passed to embed (duplicate of #7)

- [x] Same as Code Rabbit #7 above. Verify once, fix once.

---

## Deduplicated Work Items

The 17 unique concerns to verify/fix:

1. `src/rag/document-index-provider.ts` — enforce `knowledge_base` scoping (Code Rabbit #1, cubic #20)
2. `src/rag/indexers/background-indexer.ts` + `VectorStore` — proper stale purge with `listIds()` (Code Rabbit #2, cubic #17, #18)
3. `src/rag/knowledge-store.ts` — source filter maps to `metadata.source` (Code Rabbit #3, cubic #26)
4. `src/session/session-database.ts` — pending delete race (Code Rabbit #4, cubic #19)
5. `src/workers/coding-worker/workflow/loop.ts` — block on missing verification (Code Rabbit #5, cubic #15)
6. `CUBIC_PROMPTS.md` — move to `docs/` (Code Rabbit #6)
7. `src/rag/embeddings.ts` — pass `env` to single embed (Code Rabbit #7, cubic #27)
8. `code-intelligence-tools.ts` — remove dead `lspTools` (Code Rabbit #8)
9. `lsp-client-manager.ts` — graceful idle eviction shutdown (Code Rabbit #9)
10. `lsp-server-registry.ts` — fix Unix discovery (Code Rabbit #10, cubic #12)
11. `lsp-tools.ts` — decide/fix sandbox requirement (Code Rabbit #11, cubic #24)
12. `session-persistence.ts` — prevent fire-and-forget reintroducing deleted memory (cubic #13)
13. `sqlite-protocol-provider.ts` — propagate updated base protocol releases (cubic #14)
14. `lsp-client-manager.ts` — clear didOpen dedupe on client eviction (cubic #16)
15. `code-intelligence-tools.ts` — memoize/reuse LSP tools and aggregate duplicate symbols (cubic #21, #22)
16. `lsp-json-rpc.ts` — release consumed buffer (cubic #25)
17. `docs/superpowers/plans/cubic-fixes-pr-23-25-26.md` — fix malformed checkbox (cubic #23)

---

## Final Verification

- [x] Run `pnpm run typecheck`.
- [x] Run `pnpm test`.
- [x] Run `pnpm run build`.
- [x] Fix any failures.
- [x] Push updates to `codex/cubic-fixes-pr-23-25-26`.
- [x] Confirm PR #31 reflects changes.

---

## Note

This checklist preserves the existing branch `codex/cubic-fixes-pr-23-25-26` / PR #31. No new worktree is created; fixes land as additional commits on the current PR branch.
