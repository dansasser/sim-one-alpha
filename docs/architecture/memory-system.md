# Memory System (Structured Memory)

The Memory Helper is SIM-ONE Alpha's durable memory: **checklists, todos, and session notes** that survive across long-running tasks and process restarts. It is a Rust crate compiled to WebAssembly, backed by SQLite, with a TypeScript shim that the agent tools call.

This doc is the architecture reference. For the quick-start (build + smoke + config), see the [Memory Helper](../../README.md#memory-helper-structured-memory) section of the README.

## Layers

```text
model tools  (src/engine/tools/memory-*.ts, src/engine/workers/coding-worker/tools/coding-task-memory-tools.ts)
  │  trusted scope injected here (eventId / worker context); model never supplies scope
  ▼
TypeScript shim          src/engine/memory/rust-memory-engine.ts
  │  RustMemoryEngine      — loads the WASM, delegates every call
  │  InMemoryMemoryEngine  — pure-TS parity reference for unit tests
  ▼
Rust engine (WASM)       crates/gorombo-memory/  →  pkg/gorombo_memory_bg.wasm  (wasm-pack)
  │  data model + scope matching + tag/keyword scoring + cycle/depth validation
  ▼
PersistingMemoryEngine   src/engine/memory/structured-memory-runtime.ts
  │  wraps the engine: every create/update/delete is persisted to SQLite
  │  cold start: hydrate the WASM index from SQLite via reconcile_index
  ▼
SQLite durable store     .gorombo/db/structured-memory.sqlite  (table: structured_memory_records)
  ▼
retrieve_memory          src/engine/memory/checklist-memory-provider.ts  (provider 'structured-memory')
  │  ranked + truncated to the context budget, alongside session memory + RAG
```

## Rust engine (`crates/gorombo-memory/`)

The crate owns the data model, validation, and query logic. It is compiled to WASM with `wasm-pack` (`pnpm run wasm:build`) and the artifact is copied into `.gorombo/sim-one-alpha/memory/` for the built server.

WASM exports (each takes/returns JSON; `Err(String)` prefixes map to `MemoryEngineError` kinds `validation` / `not_found` / `conflict` / `internal`):

| Export | Purpose |
|---|---|
| `memory_helper_version` | Engine/module version (asserts the loaded WASM matches the expected build). |
| `create_checklist` / `update_checklist` | Checklist CRUD. |
| `add_checklist_item` / `update_checklist_item` | Nested item CRUD (parentId tree, ordinal, status, tags, due). |
| `create_todo` / `update_todo` | Todo CRUD (priority, status, due, tags). |
| `create_session_note` / `update_session_note` | Session note CRUD (importance, optional semantic search). |
| `query_records` | Scope-filtered keyword/tag search with scoring. |
| `delete_record` | Soft/hard delete per retention policy. |
| `reconcile_index` | Rebuild the WASM in-memory index from a snapshot (cold-start hydration). |

Internals:
- `InMemoryIndex` (`src/index.rs`) — `by_id` map plus `tag_index` and `title_index` inverted indexes. `query_tags` uses the `tag_index` (O(K) over matching records).
- `Scope` (`src/scope.rs`) — `matches(record, query)` is the trust boundary: a record scoped to `projectId=A` is never returned to a query whose `projectId` is `B` or absent. Global records are visible to all queries.
- `validate_request` (`src/validate.rs`) — rejects empty required fields and empty scopes (`scope must carry at least one of actorId/conversationId/projectId/threadId/global`).

## TypeScript shim (`src/engine/memory/rust-memory-engine.ts`)

`RustMemoryEngine` loads the WASM module, keeps a TS-side cache, and maps each `MemoryEngine` interface method to the corresponding WASM export. `InMemoryMemoryEngine` is a pure-TypeScript implementation of the same `MemoryEngine` contract used as a parity reference in unit tests (so test behavior does not depend on a built WASM artifact).

The `MemoryEngine` contract (`src/engine/memory/memory-engine.ts`) is the boundary: callers inject scope and audit fields; the engine owns no `actorId`/`conversationId`/`projectId`/`threadId`/`global`.

## Durability (`src/engine/memory/structured-memory-runtime.ts`)

`getStructuredMemoryRuntime(config)` is the lazily-initialized singleton. On first access it:
1. opens the SQLite store (`GoromboStructuredMemoryDatabase`),
2. runs cold-start cleanup (archive/delete past `retentionDays` / `archiveDeleteDays`),
3. loads the WASM engine (falls back to `InMemoryMemoryEngine` if the artifact is absent),
4. hydrates the engine from SQLite via `reconcile_index`.

`PersistingMemoryEngine` wraps the engine so every mutation is persisted to SQLite. On a persistence failure it rolls the in-memory index back from the durable store (reconcile from `loadAllRecords`) rather than leaving memory and DB divergent. `delete()` persists to SQLite before mutating in-memory.

### SQLite schema (`structured_memory_records`)

```sql
id TEXT PRIMARY KEY,
kind TEXT NOT NULL,                 -- 'checklist' | 'todo' | 'session_note'
title TEXT NOT NULL,
slug TEXT,
scope_json TEXT NOT NULL,           -- { actorId?, conversationId?, projectId?, threadId?, global? }
actor_id TEXT, conversation_id TEXT, project_id TEXT, thread_id TEXT, global INTEGER,
status TEXT NOT NULL,
tags_json TEXT NOT NULL,
updated_at TEXT NOT NULL, created_at TEXT NOT NULL,
record_json TEXT NOT NULL          -- full denormalized record
-- indexes: project_id, conversation_id, actor_id, kind, updated_at
```

## Scope: truth, never from the model

Scope is injected by the caller and never trusted from the model.

- **Orchestrator tools** (`src/engine/tools/memory-checklist-tools.ts`, `memory-todo-tools.ts`, `memory-note-tools.ts`) derive all scope fields from a trusted persisted `NormalizedMessageEvent` (`eventId`). Update operations pass `expectedScope`; the engine's `assertExpectedScope` verifies the target record's scope matches before mutating.
- **Coding-worker tools** (`src/engine/workers/coding-worker/tools/coding-task-memory-tools.ts`) inject `projectId` from the worker context (`CodingWorkspaceTargetInput`). Each `execute` calls `requireTrustedScope()` and fails closed if no trusted scope was injected. Mutating writes route through `SharedCodingApprovalService` as an audit-only `memory.write` event (never blocking).

## Retrieval (`retrieve_memory`)

The `structured-memory` provider (`src/engine/memory/checklist-memory-provider.ts`) runs a scoped keyword/tag query against the engine and returns `RetrievedContext` records, ranked and truncated to the context budget (`maxContextTokens`, `defaultLimit`) alongside session-memory chunks and RAG results.

Session notes are optionally searchable by LanceDB semantic similarity (`StructuredMemoryNoteIndex`), merged with the keyword index via reciprocal rank fusion, with a graceful keyword-only fallback when no embedding client is configured.

## Configuration

`memory` block in `gorombo.config.json`:

```json
{
  "memory": {
    "enabled": true,
    "backend": "sqlite",
    "defaultLimit": 10,
    "maxContextTokens": 1500,
    "enableSemanticNotes": true,
    "retentionDays": 30,
    "archiveDeleteDays": 365,
    "maxChecklistDepth": 5
  }
}
```

`GOROMBO_MEMORY_*` env vars override any field (env wins over JSON): `GOROMBO_MEMORY_BACKEND`, `GOROMBO_MEMORY_SQLITE_PATH`, `GOROMBO_MEMORY_RETENTION_DAYS`, `GOROMBO_MEMORY_ARCHIVE_DELETE_DAYS`, `GOROMBO_MEMORY_MAX_CHECKLIST_DEPTH`, `GOROMBO_MEMORY_DEFAULT_LIMIT`, `GOROMBO_MEMORY_MAX_CONTEXT_TOKENS`.

## Tests and smoke

- Rust crate: `pnpm run cargo:test` (`cargo test -p gorombo-memory`).
- TS unit tests: `pnpm run test:unit` (uses `InMemoryMemoryEngine` parity; no WASM build required).
- End-to-end + durability: `pnpm run wasm:build && pnpm run smoke:memory` (drives the real WASM engine + SQLite + `retrieve_memory` + coding-worker path; optional `GOROMBO_SMOKE_REAL_MODEL=1` for a live-model run).
