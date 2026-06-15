# cubic-dev-ai "Prompt for AI agents" — PRs #23, #25, #26

This file contains the verbatim "Prompt for AI agents (unresolved issues)"
content extracted from the cubic-dev-ai review comments on the merged PRs listed
below. The prompts are grouped by PR and preserve the original file/violation
structure.

---

## PR #23 — Protocol provider / seeding / admin fixes

> Source: cubic-dev-ai review on PR #23
> 5 issues found across 16 files

```text
Check if these issues are valid — if so, understand the root cause of each and fix them. If appropriate, use sub-agents to investigate and fix each issue separately.


<file name="scripts/protocol-admin.mjs">

<violation number="1" location="scripts/protocol-admin.mjs:206">
P2: Use INSERT OR IGNORE here. Rerunning `protocols:seed` silently destroys a user override that shares a base-protocol id.</violation>

<violation number="2" location="scripts/protocol-admin.mjs:302">
P1: Block base ids here. `protocols:disable` can turn off governance protocols like `global.protocols-first`, removing them from runtime.</violation>
</file>

<file name="src/workers/coding-worker/workflow/loop.ts">

<violation number="1" location="src/workers/coding-worker/workflow/loop.ts:96">
P2: `protocolBundle` is logged but never enforced, so loaded governance directives do not affect coding-worker behavior.</violation>
</file>

<file name="src/protocols/sqlite-protocol-provider.ts">

<violation number="1" location="src/protocols/sqlite-protocol-provider.ts:58">
P1: Base-protocol seeding unconditionally overwrites user overrides by ID on startup, so overrides are not persistent across restarts.</violation>

<violation number="2" location="src/protocols/sqlite-protocol-provider.ts:201">
P2: setEnabled mutates base protocols directly because the UPDATE query is not scoped to user protocols.</violation>
</file>
```

---

## PR #25 — LSP / code-intelligence fixes

> Source: cubic-dev-ai review on PR #25
> 8 issues found across 16 files

```text
Check if these issues are valid — if so, understand the root cause of each and fix them. If appropriate, use sub-agents to investigate and fix each issue separately.


<file name="src/workers/coding-worker/tools/code-intelligence/lsp/lsp-json-rpc.ts">

<violation number="1" location="src/workers/coding-worker/tools/code-intelligence/lsp/lsp-json-rpc.ts:28">
P1: JSON-RPC framing/decoding is incorrect for non-ASCII payloads because it treats byte-framed data as JS strings. This can break response parsing and leave requests unresolved when servers return Unicode text.</violation>
</file>

<file name="src/workers/coding-worker/tools/code-intelligence/lsp/lsp-types.ts">

<violation number="1" location="src/workers/coding-worker/tools/code-intelligence/lsp/lsp-types.ts:86">
P1: `LspPrepareRenameResult` omits the bare `Range` response variant from `textDocument/prepareRename`. This can cause valid rename-prep results to be normalized to null and disable rename handling.</violation>
</file>

<file name="src/workers/coding-worker/tools/code-intelligence/lsp/lsp-server-registry.ts">

<violation number="1" location="src/workers/coding-worker/tools/code-intelligence/lsp/lsp-server-registry.ts:12">
P1: Unix server discovery call is malformed: `sh -c` runs `command -v` without the target command. On non-Windows this makes LSP lookup fail and forces AST fallback even when language servers are installed.</violation>
</file>

<file name="src/workers/coding-worker/tools/code-intelligence/code-intelligence-tools.ts">

<violation number="1" location="src/workers/coding-worker/tools/code-intelligence/code-intelligence-tools.ts:85">
P1: LSP tools are wired to `options.sandbox` only, so default code paths without an injected sandbox cannot use LSP and silently degrade to AST fallback. This breaks the intended LSP-first behavior.</violation>

<violation number="2" location="src/workers/coding-worker/tools/code-intelligence/code-intelligence-tools.ts:443">
P2: Using `.find` here makes LSP results arbitrarily single-symbol instead of full by-name results across scope. Duplicate names can return incomplete or misleading results.</violation>
</file>

<file name="src/workers/coding-worker/tools/code-intelligence/lsp/lsp-client-manager.ts">

<violation number="1" location="src/workers/coding-worker/tools/code-intelligence/lsp/lsp-client-manager.ts:122">
P2: `openDocument` always re-sends `textDocument/didOpen` for the same URI without didClose/didChange tracking. This can violate LSP document lifecycle and desync stricter language servers.</violation>

<violation number="2" location="src/workers/coding-worker/tools/code-intelligence/lsp/lsp-client-manager.ts:136">
P2: `shutdown` is sent as a notification instead of a request, so graceful LSP shutdown is skipped. This can drop server cleanup/flush work before process kill.</violation>

<violation number="3" location="src/workers/coding-worker/tools/code-intelligence/lsp/lsp-client-manager.ts:224">
P2: File URIs are built by string concatenation, which produces invalid URIs on Windows and for special characters. Invalid URIs can break server routing for initialize/open requests.</violation>
</file>
```

---

## PR #26 — RAG / memory / model registry fixes

> Source: cubic-dev-ai review on PR #26
> 18 issues found across 41 files

```text
Check if these issues are valid — if so, understand the root cause of each and fix them. If appropriate, use sub-agents to investigate and fix each issue separately.


<file name="src/models/registry.ts">

<violation number="1" location="src/models/registry.ts:6">
P2: Embedding-only cards were added to the primary/backup selection pool without role validation. This allows `models.primary` to be set to a non-chat embedding model and fail at runtime when used for agent chat.</violation>
</file>

<file name="src/rag/indexers/background-indexer.ts">

<violation number="1" location="src/rag/indexers/background-indexer.ts:50">
P1: Background reindex is upsert-only, so removed or rewritten chunks are not purged from `knowledge_docs`/`project_files`. Retrieval can return stale context that no longer exists in the workspace.</violation>
</file>

<file name="src/tools/knowledge-tool.ts">

<violation number="1" location="src/tools/knowledge-tool.ts:22">
P1: add_knowledge derives write scope from a model-provided eventId. This can let the model attach knowledge to the wrong actor/conversation by supplying another persisted event ID.</violation>
</file>

<file name="src/rag/vector/lance-db-store.ts">

<violation number="1" location="src/rag/vector/lance-db-store.ts:64">
P1: Upsert is non-atomic and can permanently drop records on write failure. Deleting old rows before a successful add creates a data-loss path.</violation>

<violation number="2" location="src/rag/vector/lance-db-store.ts:130">
P2: Table creation has a race condition under concurrent first writes. Make createTable idempotent or recover by opening the table when it already exists.</violation>
</file>

<file name="src/rag/indexers/chunker.ts">

<violation number="1" location="src/rag/indexers/chunker.ts:50">
P2: Per-chunk line-range computation rescans from file start, causing quadratic indexing cost on large files.</violation>

<violation number="2" location="src/rag/indexers/chunker.ts:53">
P1: Chunk IDs depend on chunk index, so edits can renumber chunks and leave stale vector rows after reindex.</violation>
</file>

<file name="src/session/session-database.ts">

<violation number="1" location="src/session/session-database.ts:942">
P1: Vector deletion is fire-and-forget here. Because `deleteFlueSession()` returns synchronously, an in-flight delete can race the later reindex and remove freshly upserted vectors, leaving deleted session memory searchable or wiping new vectors.</violation>
</file>

<file name="src/session/session-persistence.ts">

<violation number="1" location="src/session/session-persistence.ts:114">
P2: Session save now blocks on embedding/vector indexing and can stall request completion on embedding timeouts. Make indexing fire-and-forget with error handling so persistence latency is not tied to embedding availability.</violation>
</file>

<file name="src/routes/knowledge.ts">

<violation number="1" location="src/routes/knowledge.ts:7">
P2: Route ingress directly depends on a tool module, breaking route/tool layering and coupling HTTP startup to tool internals. Move shared persistence logic to a non-tool service module and import that instead.</violation>

<violation number="2" location="src/routes/knowledge.ts:47">
P2: Event is persisted before knowledge write succeeds, so failed `/api/knowledge` requests leave false audit/session records. Record the event only after `store.add` resolves.</violation>
</file>

<file name="src/rag/embeddings.ts">

<violation number="1" location="src/rag/embeddings.ts:60">
P2: Embedding client ignores the provided `options.env` when resolving provider credentials. `createEmbeddingClient({ env })` works for timeout but not for API key/base URL, causing wrong or missing credentials at runtime.</violation>

<violation number="2" location="src/rag/embeddings.ts:61">
P2: Local Ollama embeddings are incorrectly blocked when `OLLAMA_LOCAL_API_KEY` is unset. This breaks local-only embedding setups that rely on the existing `'ollama'` default key behavior.</violation>
</file>

<file name="src/memory/memory-provider.ts">

<violation number="1" location="src/memory/memory-provider.ts:122">
P1: Vector scope filter is mapped to the wrong field: conversationId values are filtered against actor_id. This can bypass intended actor/conversation scoping and return incorrect session memory matches.</violation>
</file>

<file name="src/rag/knowledge-store.ts">

<violation number="1" location="src/rag/knowledge-store.ts:70">
P2: Actor/conversation filters are broken because those IDs are not persisted where list() reads them. `list({ actorId|conversationId })` can return empty results even when matching records exist.</violation>

<violation number="2" location="src/rag/knowledge-store.ts:95">
P1: list() ignores built vector filters and truncates to 100 rows before applying JS filters. This can silently drop matching knowledge records.</violation>
</file>

<file name="src/rag/document-index-provider.ts">

<violation number="1" location="src/rag/document-index-provider.ts:31">
P2: `limit: 0` still triggers embedding and vector queries, wasting latency/cost. Return early before embedding when computed limit is zero.</violation>

<violation number="2" location="src/rag/document-index-provider.ts:38">
P1: Knowledge-base retrieval is not scoped by actor/conversation, allowing cross-user knowledge leakage. Apply filters when querying the `knowledge_base` collection.</violation>
</file>
```

---

## Totals

- PR #23: 5 issues
- PR #25: 8 issues
- PR #26: 18 issues
- **Total: 31 issues**
