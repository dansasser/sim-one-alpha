# Rust Memory Helper Module — Production Plan

*Repository:* `astro-flue-agent`
*Product:* GOROMBO Agent
*Path:* `crates/gorombo-memory/`, `src/memory/`, `src/tools/memory-*.ts`, `src/schemas/memory.ts`
*Updated:* 2026-06-15

## Goal

Build a production-ready Rust module, compiled to WebAssembly, that serves as the GOROMBO Agent's structured-memory subsystem. The module owns high-performance storage and retrieval of project checklists, todos, and important session notes, scoped across `actorId`, `conversationId`, `projectId`, and global contexts. It is called through a thin TypeScript shim and exposed to the orchestrator and the coding worker as Flue tools.

When this plan is fully executed, the agent can durably maintain and query:

- **Checklists** — hierarchical or flat project checklists with item status and ordering.
- **Todos** — standalone actionable tasks with priority, status, tags, due dates, and assignable scope.
- **Session notes** — short, pinned facts the model or user want remembered for a specific scope.

The module is portable (WASM), persistent, scoped, observable, and safe. It does not replace the existing session-memory or knowledge-base layers; it complements them with structured, low-latency CRUD and search.

## Definition of Done

The product is production-ready when:

1. A Rust crate `crates/gorombo-memory/` exists and compiles to WASM with `wasm-pack`.
2. The TypeScript host (`src/memory/rust-memory-engine.ts`) loads the WASM, validates its version, and exposes a typed `MemoryEngine` interface.
3. A `ChecklistMemoryProvider` implements the existing `MemoryProvider` contract so `retrieve_memory` can return structured records alongside session-memory chunks.
4. Flue tools are attached to the orchestrator and the coding worker for checklist/todo/note CRUD and search.
5. All writes are scoped and trust-derived from persisted `NormalizedMessageEvent` records; no tool accepts raw `actorId`/`conversationId` from the model.
6. Persistence is durable across process restarts via SQLite (default) with LanceDB optional for semantic note search.
7. Context payloads are ranked, truncated, and token-estimated before injection.
8. Telemetry observer events capture every mutating operation with run/agent/tool metadata.
9. Unit tests cover the Rust engine, the TS shim, scope resolution, persistence round-trips, and Flue tool contracts.
10. Real-model smoke tests demonstrate the orchestrator and coding worker creating, updating, and retrieving records end-to-end.
11. `corepack pnpm run typecheck`, `corepack pnpm run test:unit`, and `corepack pnpm run build` pass.
12. The build pipeline includes the WASM artifact and CI installs Rust + `wasm-pack`.

Until the real-model smoke test and the build pipeline are verified, the module is **not finished**.

---

## First Principles

1. **Flue first.** Tools, providers, and subagents follow the existing Flue architecture. The Rust module is an engine, not a bypass.
2. **TypeScript owns boundaries; Rust owns compute and data layout.** Persistence, trust, and Flue wiring stay in TS. Rust owns serialization, indexing, and query logic.
3. **WASM for portability.** A single `wasm-pack` artifact works for Node, Cloudflare Workers, and future deploy targets.
4. **Scope is truth.** Every record is keyed by scope. Tools derive scope from trusted persisted events, never from model arguments.
5. **Memory retrieval is bounded.** Structured records compete for the same context budget as session-memory and RAG. They must be ranked and truncated.
6. **Fail closed.** Mutating tools require a trusted `eventId` and an explicit scope match. Cross-project reads are denied by default.
7. **Observable.** Every mutation is recorded in the Flue telemetry observer and persisted with audit fields.

---

## Architecture

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                              GOROMBO Agent                                  │
│  ┌─────────────────────┐     ┌─────────────────────┐     ┌──────────────────┐ │
│  │   Orchestrator      │     │   Coding Worker     │     │  Memory Provider │ │
│  │                     │     │                     │     │  (existing + new)│ │
│  │  checklist tools    │     │  same checklist     │     │                  │ │
│  │  todo tools         │◄────│  tools, scoped to   │────►│ SessionMemory    │ │
│  │  session-note tools │     │  projectId          │     │ ChecklistMemory  │ │
│  │  retrieve_memory    │     │                     │     │ KnowledgeBase    │ │
│  └──────────┬──────────┘     └──────────┬──────────┘     └────────┬─────────┘ │
│             │                         │                          │         │
│             └─────────────────────────┴──────────────────────────┘         │
│                                       │                                      │
│                              src/memory/rust-memory-engine.ts                │
│                                       │                                      │
│                              crates/gorombo-memory/pkg (WASM)                │
│                                       │                                      │
│                              ┌────────┴─────────┐                            │
│                              │  Rust engine     │                            │
│                              │  - data model    │                            │
│                              │  - in-mem index  │                            │
│                              │  - serialization │                            │
│                              │  - query planner │                            │
│                              └────────┬─────────┘                            │
│                                       │                                      │
│                              SQLite (default)  /  LanceDB (semantic)         │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Boundary rules

- The orchestrator keeps routing and delegating. The new tools are orchestration-support tools, not substantive work tools.
- The coding worker gets the same toolset so it can maintain project-level and task-level checklists.
- Rust never opens files, network sockets, or databases directly in production. TS provides the storage backend descriptor and performs IO.
- Rust never stores per-user state in global WASM variables. All state is reconstructed from the durable store on each call.

---

## Data Model

### Record kinds

| Kind | Purpose | Identity | Status values |
|---|---|---|---|
| `checklist` | Named list of items | `id` (ULID), `slug` (unique per scope) | `active`, `archived` |
| `checklist_item` | One entry in a checklist | `id`, parent `checklistId` | `pending`, `in_progress`, `completed`, `blocked`, `skipped` |
| `todo` | Standalone task | `id` (ULID), optional `slug` | `pending`, `in_progress`, `completed`, `blocked`, `cancelled` |
| `session_note` | Pinned fact/reminder | `id` (ULID) | `active`, `archived` |

### Scope model

Every record carries an ordered set of scopes. Scope precedence (most specific wins):

1. `projectId` + `conversationId`
2. `projectId`
3. `conversationId`
4. `actorId`
5. `global`

Fields:

```ts
interface MemoryRecordScope {
  actorId?: string;
  conversationId?: string;
  projectId?: string;
  threadId?: string;
  global?: boolean;
}
```

A query supplies the available scope values; the engine returns records whose most specific matching scope is at or above the query's level. Records with `global: true` are returned only when no more specific record exists for the same title/slug, or when the query explicitly asks for global records.

### Checklist

```ts
interface Checklist {
  id: string;
  kind: 'checklist';
  title: string;
  slug: string;
  description?: string;
  scope: MemoryRecordScope;
  tags: string[];
  status: 'active' | 'archived';
  items: ChecklistItem[];
  createdAt: string;
  updatedAt: string;
  updatedBy: string;       // agent/worker identity
  runId?: string;
}

interface ChecklistItem {
  id: string;
  title: string;
  description?: string;
  status: ChecklistItemStatus;
  ordinal: number;
  tags: string[];
  dueAt?: string;
  completedAt?: string;
}
```

### Todo

```ts
interface Todo {
  id: string;
  kind: 'todo';
  title: string;
  slug?: string;
  description?: string;
  scope: MemoryRecordScope;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  status: TodoStatus;
  tags: string[];
  dueAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
  runId?: string;
}
```

### Session note

```ts
interface SessionNote {
  id: string;
  kind: 'session_note';
  title: string;
  content: string;
  scope: MemoryRecordScope;
  tags: string[];
  status: 'active' | 'archived';
  importance: 'normal' | 'high';
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
  runId?: string;
}
```

---

## Rust Crate Design

### Layout

```text
crates/gorombo-memory/
  Cargo.toml
  src/
    lib.rs              # wasm_bindgen exports; module version
    id.rs               # ULID/id generation
    scope.rs            # scope matching and precedence
    checklist.rs        # Checklist, ChecklistItem, mutations
    todo.rs             # Todo, status transitions
    note.rs             # SessionNote
    record.rs           # union Record kind + common fields
    index.rs            # in-memory inverted tag/title index
    query.rs            # Query planner and filters
    serialize.rs        # JSON serde helpers
    validate.rs         # input validation
  pkg/                  # wasm-pack output (gitignored)
```

### WASM exports

```rust
#[wasm_bindgen]
pub fn memory_helper_version() -> String;

#[wasm_bindgen]
pub fn create_checklist(json: &str) -> Result<String, String>;

#[wasm_bindgen]
pub fn update_checklist(json: &str) -> Result<String, String>;

#[wasm_bindgen]
pub fn add_checklist_item(json: &str) -> Result<String, String>;

#[wasm_bindgen]
pub fn update_checklist_item(json: &str) -> Result<String, String>;

#[wasm_bindgen]
pub fn create_todo(json: &str) -> Result<String, String>;

#[wasm_bindgen]
pub fn update_todo(json: &str) -> Result<String, String>;

#[wasm_bindgen]
pub fn create_session_note(json: &str) -> Result<String, String>;

#[wasm_bindgen]
pub fn update_session_note(json: &str) -> Result<String, String>;

#[wasm_bindgen]
pub fn query_records(json: &str) -> Result<String, String>;

#[wasm_bindgen]
pub fn delete_record(json: &str) -> Result<String, String>;

#[wasm_bindgen]
pub fn reconcile_index(json: &str) -> Result<String, String>;
```

All exports accept a JSON request and return a JSON response. Errors are returned as `Err(String)` so the TS shim can surface them as tool errors.

### In-memory index

The WASM module maintains a lightweight inverted index over record titles, descriptions, tags, and item titles. The index is rebuilt on first use after a process restart by calling `reconcile_index` with a snapshot of persisted records. This avoids long-lived mutable WASM state between calls while still enabling fast tag/keyword search.

---

## TypeScript Integration

### Files

| File | Role |
|---|---|
| `src/memory/rust-memory-engine.ts` | Load WASM, call exports, parse JSON, surface errors. |
| `src/memory/checklist-memory-provider.ts` | Implements `MemoryProvider`; converts `RagQuery` into structured-record retrieval. |
| `src/memory/memory-router.ts` | Compose `SessionMemoryProvider` + `ChecklistMemoryProvider`. |
| `src/tools/memory-checklist-tools.ts` | Flue tools for checklists. |
| `src/tools/memory-todo-tools.ts` | Flue tools for todos. |
| `src/tools/memory-note-tools.ts` | Flue tools for session notes. |
| `src/schemas/memory.ts` | Valibot schemas per `docs/architecture/schema-strategy.md`. |
| `src/types/memory.ts` | Re-exported inferred types. |

### `MemoryEngine` interface

```ts
export interface MemoryEngine {
  version(): string;
  createChecklist(input: CreateChecklistInput): Promise<Checklist>;
  updateChecklist(input: UpdateChecklistInput): Promise<Checklist>;
  addChecklistItem(input: AddChecklistItemInput): Promise<Checklist>;
  updateChecklistItem(input: UpdateChecklistItemInput): Promise<Checklist>;
  createTodo(input: CreateTodoInput): Promise<Todo>;
  updateTodo(input: UpdateTodoInput): Promise<Todo>;
  createSessionNote(input: CreateSessionNoteInput): Promise<SessionNote>;
  updateSessionNote(input: UpdateSessionNoteInput): Promise<SessionNote>;
  query(input: QueryInput): Promise<MemoryRecord[]>;
  delete(input: DeleteInput): Promise<void>;
  reconcile(snapshot: MemoryRecordSnapshot): Promise<void>;
}
```

### Persistence backends

The TS layer selects a backend at runtime:

| Backend | Description |
|---|---|
| `sqlite` (default) | Records stored in `.gorombo/db/structured-memory.sqlite`. TS performs SQL CRUD; Rust does query planning and indexing on the snapshot. |
| `lancedb` | Optional semantic search over note content using the existing `LanceDbVectorStore` and embedding client. |
| `memory` | Ephemeral backend for unit tests. |

### Trust boundary

Every mutating tool follows the same pattern as `retrieve_memory` and `add_knowledge`:

```ts
const event = getTrustedEvent(eventId);
const scope = deriveScope(event);
const record = await engine.createChecklist({ ...input, scope, updatedBy: 'orchestrator' });
```

`getTrustedEvent` loads the persisted `NormalizedMessageEvent` from `GoromboSessionDatabase`. `deriveScope` extracts `actorId`, `conversationId`, `projectId`, and `threadId` from the event and its `context`. The model is never allowed to supply scope directly.

---

## Flue Tool Surface

### Orchestrator tools

Attach to `src/agents/orchestrator.ts`:

- `create_checklist` — create a new checklist for the current scope.
- `update_checklist` — archive, rename, or replace items.
- `add_todo` — create a todo.
- `complete_todo` / `update_todo` — status transitions.
- `store_session_note` — pin a note.
- `archive_session_note` — soft-delete a note.
- `search_memory_records` — keyword/tag search across structured memory.

The existing `retrieve_memory` tool continues to exist and is enhanced via `ChecklistMemoryProvider` so that checklist/todo/note records can be surfaced as `RetrievedContext` when relevant.

### Coding worker tools

Attach the same tools to `src/workers/coding-worker/coding-worker.ts`. In addition, provide worker-local helpers:

- `coding_task_add_todo` — create a todo scoped to the current coding task/project.
- `coding_task_complete_todo` — mark a coding task todo complete.
- `coding_task_create_checklist` — project-level checklist (e.g., "Phase 2 migration").
- `coding_task_store_note` — pin a decision or convention discovered during the run.

These are thin aliases that inject `projectId` from the worker request context and require the same `eventId` trust model.

---

## Retrieval and Context Budget

### Ranking

When `ChecklistMemoryProvider.retrieve(query)` is called, the engine returns records in this order:

1. Exact title/slug match.
2. Tag overlap score.
3. Keyword frequency in title/description.
4. Recency (`updatedAt` descending).

### Truncation

Before returning records as `RetrievedContext`, the provider:

1. Estimates token count using `estimateTextTokens` from `src/session/context-budget.ts`.
2. Applies a per-call limit (default from config, overridable via `query.limit`).
3. Returns top-K records whose total token estimate fits within a budget passed by the caller.

### LanceDB semantic search (optional)

For `session_note` content, the TS layer can embed the query text and search a `structured_memory_notes` LanceDB collection. Results are merged with the keyword index using reciprocal rank fusion, mirroring the existing `SessionMemoryProvider` approach.

---

## Observability and Audit

Every mutation record carries:

- `updatedBy`: agent or worker identity string.
- `runId`: Flue run id from the current tool invocation.
- `createdAt` / `updatedAt`: ISO timestamps.

The TS tool wrappers emit Flue telemetry observer events via the existing `observe(...)` path in `src/telemetry/flue-telemetry.ts`. Event type: `memory_mutation` with sanitized fields (id, kind, scope keys, toolName, runId).

---

## Security and Safety

1. **Scope isolation.** A record scoped to `projectId=A` is never returned to a query whose trusted event only carries `projectId=B`.
2. **Path safety.** Storage paths are resolved under `.gorombo/db/`; absolute paths and `..` segments are rejected.
3. **No WASM filesystem access.** Rust does not use `std::fs` in production builds.
4. **Approval gating (coding worker).** Mutating tools invoked by the coding worker route through `SharedCodingApprovalService` when configured, the same way file edits do.
5. **Schema validation.** All tool inputs pass through Valibot schemas; all Rust inputs are validated inside the WASM engine.

---

## Configuration

Add to `GoromboConfig` in `src/config/gorombo-config.ts`:

```ts
interface GoromboMemoryConfig {
  enabled?: boolean;
  backend?: 'sqlite' | 'lancedb' | 'memory';
  sqlitePath?: string;
  defaultLimit?: number;
  maxContextTokens?: number;
  enableSemanticNotes?: boolean;
}
```

Default `gorombo.config.json` should keep the feature enabled with the SQLite backend and conservative limits.

Environment variables:

- `GOROMBO_MEMORY_BACKEND`
- `GOROMBO_MEMORY_SQLITE_PATH`
- `GOROMBO_MEMORY_DEFAULT_LIMIT`
- `GOROMBO_MEMORY_MAX_CONTEXT_TOKENS`

---

## Test Strategy

### Rust tests

- `cargo test` inside `crates/gorombo-memory/`.
- Scope matching precedence.
- Checklist/todo/note CRUD and JSON round-trips.
- Query ranking and tag filtering.
- Validation rejects malformed inputs.

### TypeScript unit tests

- `src/tests/rust-memory-engine.test.ts` — WASM load, version check, pure-JS fallback backend.
- `src/tests/checklist-memory-provider.test.ts` — scope isolation, retrieval as `RetrievedContext`, token truncation.
- `src/tests/memory-checklist-tools.test.ts` — tool input validation, trusted event lookup, error paths.
- `src/tests/coding-worker-memory-tools.test.ts` — worker-local aliases inject project scope correctly.

### Integration / smoke

- `scripts/smoke-memory-helper.mjs` — real-model run that creates a checklist, adds todos, stores a note, and retrieves them via the orchestrator.

### CI

- Install Rust stable and `wasm-pack`.
- Run `wasm-pack build --target nodejs` for `crates/gorombo-memory/`.
- Run `corepack pnpm run typecheck` and `corepack pnpm run test:unit`.
- Ensure `flue build` copies the `.wasm` artifact into `dist/`.

---

## Build and Packaging

### wasm-pack target

Use `--target nodejs` so the generated JS uses Node's `WebAssembly` global and synchronous instantiation, which fits the existing synchronous module-load style of the repo.

### Package.json scripts

Add:

```json
{
  "scripts": {
    "wasm:build": "wasm-pack build crates/gorombo-memory --target nodejs --out-dir pkg",
    "prebuild": "pnpm run wasm:build && node scripts/copy-runtime-config.mjs",
    "build": "flue build --target node"
  }
}
```

### Copy script

Extend `scripts/copy-runtime-config.mjs` or add `scripts/copy-wasm-artifact.mjs` to copy `crates/gorombo-memory/pkg/gorombo_memory_bg.wasm` into `dist/` with a stable relative path.

### Git hygiene

- `crates/gorombo-memory/pkg/` is gitignored.
- `crates/gorombo-memory/Cargo.lock` is committed if the crate is treated as a standalone package.
- `crates/gorombo-memory/target/` is gitignored.

---

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Rust toolchain not available in current environment | Install Rust stable + `wasm-pack` before implementation. Document in README. |
| `flue build` does not bundle `.wasm` | Add post-build copy script; verify with `pnpm run build` and inspect `dist/`. |
| WASM module cached in dev/test process | Restart process on rebuild; assert `version()` in engine constructor. |
| SQLite schema drift between TS and Rust | TS owns the schema; Rust validates on every snapshot. |
| Context budget overflow from too many records | Rank, token-estimate, and truncate in `ChecklistMemoryProvider`. |
| Cross-scope data leak | Scope derived from trusted persisted event; engine enforces precedence. |
| Coding worker approves its own memory writes | Route mutating tools through `SharedCodingApprovalService` when in worker context. |
| LanceDB optional path breaks when no embedding client | Gracefully fall back to keyword-only search and surface a provider failure. |

---

## Suggested Phase Structure

This plan describes the finished product. Phasing is decided by the project owner, but the natural split is:

### Phase 0 — Shared contracts

- `src/schemas/memory.ts`
- `src/types/memory.ts`
- `MemoryEngine` interface
- `ChecklistMemoryProvider` skeleton

This should be a small lead PR so parallel branches can depend on it.

### Phase 1 — Rust engine + TypeScript shim

- Scaffold `crates/gorombo-memory/`.
- Implement checklist/todo/note data model, validation, and JSON exports.
- Build `src/memory/rust-memory-engine.ts` with pure-JS `memory` backend and WASM backend.
- Unit tests for Rust + TS shim.

### Phase 2 — SQLite persistence + provider integration

- Add SQLite schema and TS-owned CRUD.
- Implement `ChecklistMemoryProvider.retrieve`.
- Wire `retrieve_memory` to surface structured records.
- Add token truncation and scope isolation tests.

### Phase 3 — Flue tools

- Orchestrator tools in `src/agents/orchestrator.ts`.
- Coding worker tools in `src/workers/coding-worker/coding-worker.ts`.
- Tool tests and trusted-event validation tests.

### Phase 4 — LanceDB semantic notes (optional)

- Embed note content.
- Add `structured_memory_notes` LanceDB collection.
- Merge keyword + vector results.

### Phase 5 — Build pipeline, CI, observability, real-model smoke test

- `wasm-pack` integration in `package.json` and CI.
- Telemetry audit events.
- Smoke test script.
- README updates.

---

## Open Questions

1. Should checklists support nested items in v1, or flat lists only?
2. Is there a preferred product name for the user-facing feature (e.g., "Memory Helper", "Task Memory", "Project Memory")?
3. Should completed todos be soft-retained forever, compacted after N days, or hard-deleted?
4. Should the coding worker's memory writes require human approval by default, or only when the worker is operating on an external repo?
5. Should session notes be included in `retrieve_memory` by default, or surfaced only through a dedicated `retrieve_session_notes` tool?

These questions do not block planning, but they affect scope and phasing decisions.
