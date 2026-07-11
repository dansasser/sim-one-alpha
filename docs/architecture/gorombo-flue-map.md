# SIM-ONE Alpha Flue Map

This file maps Flue architecture to this repository.

## Top-Level Source Directory Map

Every top-level `src/` entry should fit one of these categories: Flue-contract files (`src/agents/`, `src/workflows/`, `src/channels/`, `src/skills/`, `src/db.ts`, `src/app.ts`), root support files (`src/index.ts`, `src/workspace-loader.ts`, `src/AGENTS.md`), or one of the consolidation buckets (`src/core/`, `src/api/`, `src/engine/`, `src/workspace/`, `src/tests/`). If a new directory is added, update this map in the same change.

### Flue-contract top-level files and directories

Flue discovers these at the `src/` root. They cannot be moved into buckets.

| Path | Type | Ownership rule |
| --- | --- | --- |
| `src/agents/` | Flue agent entrypoints | Main `createAgent(...)` files discovered by Flue. Each immediate file defines one agent; its filename becomes the agent name. |
| `src/workflows/` | Flue workflows | Finite Flue operations that can initialize agents, manage bounded loops, and return structured results. Each immediate file defines one discovered workflow. |
| `src/channels/` | Flue-native channel handlers | First-party provider ingress (e.g. Telegram) discovered by Flue under `/channels/<name>/...`. |
| `src/skills/` | Flue Agent Skills | Application-owned Agent Skills imported with `with { type: 'skill' }` and registered on the owning agent or workflow. These are built-in Flue runtime skills, not post-build registry capabilities. |
| `src/db.ts` | Flue persistence adapter entrypoint | Flue Node persistence adapter entrypoint discovered by Flue at build time. Exports the SIM-ONE Alpha persistence adapter wrapper around Flue's sqlite() adapter. |
| `src/app.ts` | Application entrypoint | Hono application shell and Flue route mount. |

### `src/core/` — cross-cutting foundations

| Path | Type | Ownership rule |
| --- | --- | --- |
| `src/core/config/` | Runtime configuration | Typed config loaders and shipped runtime config source files. |
| `src/core/models/` | Model subsystem | Model cards, provider registration, model registry, limits, and runtime bootstrap. |
| `src/core/protocols/` | Protocol storage/access subsystem | Protocol schemas and provider implementations used by protocol tools. |
| `src/core/schemas/` | Shared runtime schemas | Valibot schemas for structured-output contracts and cross-subsystem data shapes. Each domain owns a file here when its schemas are reused outside a single file. `memory.ts` is the source of truth for the Rust Memory Helper record/input shapes. Imported by `src/core/types/` and worker type contracts; kept separate so type-only consumers do not pull in schema runtime code. |
| `src/core/telemetry/` | Observability subsystem | Sanitized Flue event capture and run summaries. |
| `src/core/types/` | Shared TypeScript contracts | Public/common interfaces used across subsystems. |
| `src/core/utils/` | Generic helpers | Small cross-cutting helpers only; domain subsystems do not belong here. |

### `src/api/` — HTTP/connector ingress surface

| Path | Type | Ownership rule |
| --- | --- | --- |
| `src/api/connectors/` | Connector normalization | External-source adapters that normalize input into internal message shapes. Legacy Telegram ingress moved to `src/channels/telegram.ts`. |
| `src/api/ingress/` | Application ingress modules | Cross-cutting ingress logic that turns internal worker events and storage into HTTP/connector-facing surfaces. Example: the approval ingress bridges `CodingApprovalService` to HTTP routes, CLI, and connectors. |
| `src/api/middleware/` | HTTP middleware | Reusable Hono middleware such as API-secret auth. |
| `src/api/routes/` | HTTP route modules | Concrete app-owned Hono route registration modules. |

### `src/engine/` — agent runtime and capabilities

| Path | Type | Ownership rule |
| --- | --- | --- |
| `src/engine/approvals/` | Shared approval subsystem | Approval service factory and ingress types shared by the coding worker and connectors/HTTP/CLI surfaces. |
| `src/engine/capabilities/` | Runtime capability registry subsystem | SQLite-backed user/agent-added capability store (skills, tools, workers, MCP). `capability-store.ts` owns CRUD; `capability-loader.ts` reads enabled rows at orchestrator init; `skill-materializer.ts` copies/github-clones user skill dirs into Flue's discovery path; `mcp-broker.ts` connects MCP servers and returns tools. Loaded at `createAgent(...)` init in `src/agents/orchestrator.ts`. See `scripts/capability-admin.mjs` for CLI admin. |
| `src/engine/commands/` | Pre-LLM command parsing | Slash command definitions and parsing that run before prompts reach the LLM. |
| `src/engine/embeddings/` | Bundled local embedding model | In-process ONNX + tokenizer path used by the RAG embedding fallback. |
| `src/engine/memory/` | Shared memory subsystem | Memory retrieval interfaces and routing shared by agents/tools/workflows. Hosts `rust-memory-engine.ts`, the TypeScript shim for the `gorombo-memory` WASM engine (structured memory: checklists, todos, session notes), and `checklist-memory-provider.ts`, the structured-memory RAG provider. Also hosts `knowledge-service.ts` (the shared service module folded in from the removed `src/services/` directory). |
| `src/engine/rag/` | Shared retrieval subsystem | Retrieval provider interfaces and routing. This name is pending a user-selected rename, but the concept remains top-level because it is shared architecture. |
| `src/engine/registries/` | Registry subsystem | Typed registries for tools, skills, agents, protocols, and future discoverable capabilities. |
| `src/engine/schedules/` | Scheduled execution subsystem | Standalone scheduled/recurring/one-shot agent execution: schedule definitions + run history durable in SQLite (`node:sqlite`, `.gorombo/db/schedules.sqlite`), firing via Croner in-process, rehydrated on restart. Dispatch is admission-only (`dispatch(...)` to the orchestrator); terminal status observed in-process via `observe()`. Exposed via orchestrator `schedule_*` tools, coding-worker `coding_schedule_*` aliases (lead-only), and the `/api/schedules/*` admin route. See `docs/architecture/schedules-system.md`. |
| `src/engine/session/` | Session/context subsystem | Flue session persistence, compaction policy, context budget, and usage tracking. |
| `src/engine/tools/` | Model-callable tools | `defineTool(...)` capabilities attached only to owning agents. |
| `src/engine/workers/` | Worker/subagent implementations | Specialized worker profiles plus worker-local support code and worker workspaces. |

### `src/workspace/` — agent persona content

| Path | Type | Ownership rule |
| --- | --- | --- |
| `src/workspace/` | Main agent workspace content | User-editable persona markdown for the main agent. Also the default coding-worker sandbox root; code work lives under `repos/` and non-git projects under `projects/` inside this directory. No TypeScript runtime code belongs here. |

### `src/tests/` — test suite

| Path | Type | Ownership rule |
| --- | --- | --- |
| `src/tests/` | Test suite | Node test files compiled to `.tmp/tsc/tests`. |

Top-level non-`src/` directories:

| Path | Type / ownership rule |
| --- | --- |
| `crates/gorombo-memory/` | Rust engine compiled to WebAssembly via `wasm-pack`. Owns the structured-memory data model, validation (scope non-empty, slug uniqueness, checklist cycle/depth), the in-memory inverted index, and the query planner. Never exposed to the model or agents directly — only via `src/engine/memory/rust-memory-engine.ts`. The TypeScript shim generates ids/timestamps/audit fields (Rust owns no clock/RNG in the WASM target) and passes fully-formed records to the WASM exports. The WASM module keeps a `thread_local` store hydrated by `reconcile_index` from the durable SQLite store on cold start. |
| `sim-one-cli/` | Product command wrapper. Owns `sim-one` command routing, capability subcommands, and the legacy `--ink` fallback. No-argument `sim-one` launches the packaged Ratatui binary instead of owning terminal UI state itself. |
| `tui/ratatui/` | Production local terminal client. Owns Ratatui rendering, shared word-boundary wrapping for transcript and prompt rows, multiline prompt editing (including local `/` then Enter newline insertion), immediate display of Flue `message_end`, HTTP-result reconciliation, frame-level transcript live-tail enforcement, the virtual blank tail margin, manual scrollback, TUI-local slash commands, gateway launch/reuse, stream attach/restart, and the packaged `sim-one-ratatui-tui` binary. It is a connector surface, not an agent runtime. |
| `scripts/` | Build, smoke, and admin scripts. TUI-relevant scripts include `build-ratatui-tui.mjs`, `check-sim-one-product-command.mjs`, `test-ratatui-product.mjs`, `test-ratatui-interactive.py`, `test-ratatui-visible-final.py`, `test-tui-e2e.mjs`, `test-built-http.mjs`, and `capability-admin.mjs`. |
| `docs/tui/` | User-facing TUI guides. Keep command and behavior descriptions aligned with `docs/architecture/tui-cli-session-flow.md`. |
| `docs/operations/` | Operator runbooks for packaged runtime and connectors. `product-tui.md` owns packaged launch, runtime paths, env files, and smoke commands. |

Root source files:

```text
src/app.ts
  Hono application shell and Flue route mount.

src/db.ts
  Flue Node persistence adapter entrypoint discovered by Flue at build time.
  Exports the SIM-ONE Alpha persistence adapter wrapper around Flue's sqlite() adapter.

src/index.ts
  Package barrel for exported connector, registry, and type helpers.
  It must not re-export removed non-Flue orchestrator or gateway paths.

src/workspace-loader.ts
  Shared workspace markdown loader.
  Composes workspace files in a fixed order for agent instructions.
  Stays as a root support file because it is currently the only file in this category.
  Keeps user-editable workspace content separate from TypeScript agent entrypoints.
```

## Runtime Surfaces

```text
src/app.ts
  Hono application shell.
  Mounts Flue with app.route('/', flue()).
  May expose health checks and app-owned ingress.
  Registers the lightweight Flue telemetry observer.
  Applies imported API-secret middleware to public Flue route families.
  Custom chat ingress forwards to the durable Flue orchestrator agent route.
  Must not call the old non-Flue orchestrator.

src/api/middleware/api-secret.ts
  Imported Hono middleware for API-secret auth.
  Reads runtime env bindings and Node process env.
  Bypassed for loopback origins (127.0.0.1, ::1). Fails closed for non-loopback when API_SECRET is missing.

src/api/routes/chat-events.ts
  App-owned /api/chat/events ingress alias.
  Verifies API-secret middleware, exposes /api/chat/sessions for HTTP chat lists, normalizes the HTTP boundary, persists trusted event context, resolves the product session, handles pre-LLM slash commands (/new, /clear, /resume, /rename, /compact, /session), and prompts the durable /agents/orchestrator/:sessionId route.
  Does not call c.executionCtx, a workflow route for normal chat execution, or a non-Flue orchestrator.

sim-one-cli/src/cli.tsx
  Product CLI wrapper.
  Routes no-subcommand `sim-one` to the packaged Ratatui binary.
  Routes `skill`, `tool`, `worker`, and `mcp` subcommands to capability management without launching the TUI.
  Keeps `--ink` as a legacy fallback path only.

tui/ratatui/src/main.rs
  Ratatui binary entrypoint.
  Wires gateway startup/reuse, scripted product-smoke prompt modes, terminal setup/restore, event loop, and final `/exit` session-id output.

tui/ratatui/src/gateway.rs
  Packaged gateway launcher.
  Resolves server/env/config paths, checks /health, starts `.gorombo/sim-one-alpha/server.mjs` when needed, sets the child cwd to the owner of the `.gorombo` runtime tree, and stops only a child process it started.

tui/ratatui/src/agent.rs
  TUI HTTP client.
  Sends normal prompts and backend-owned slash commands through `/api/chat/events` as connector `tui` with stable `local-tui` actor/conversation/thread scope and the active durable session id.
  Reads `/api/chat/sessions` for `/sessions`.

tui/ratatui/src/app.rs
  TUI state reducer.
  Owns prompt editing, transcript scroll state, pending spinner/status, immediate final-message display from Flue `message_end`, in-place HTTP reconciliation, final-response/activity ordering, the rendered-only blank tail margin, TUI-local commands (`/session`, `/sessions`, `/help`, `/exit`), backend command response handling for `/new`, `/clear`, `/resume`, `/rename`, `/compact`, active session switching, and stream restart.

tui/ratatui/src/text_wrap.rs
  Shared transcript/prompt row layout.
  Wraps before a word that does not fit, never splits words across rows, preserves explicit newlines, and retains source character ranges for prompt cursor placement.

src/api/routes/knowledge.ts
  App-owned /api/knowledge and /api/knowledge/reindex routes.
  Accepts API-secret-authenticated knowledge entries, persists them to the vector knowledge base, and triggers background re-indexing of project files and knowledge docs.

src/engine/schedules/boot.ts
  Side-effect boot target imported by src/app.ts (mirrors ./core/models/runtime.js).
  Loads the schedules config block, installs schedule telemetry, constructs + starts the ScheduleManager singleton (schema, cleanup, observe subscription, rehydrate enabled Croner jobs), and registers SIGTERM/SIGINT drain. Skips when disabled or in test mode; a start failure logs and leaves the manager unset so the rest of the app runs. Schedules are app-owned business data in their own node:sqlite file, NOT the Flue sqlite() adapter.

src/api/routes/schedules.ts
  App-owned /api/schedules/* admin route (full v1), behind requireApiSecret.
  CRUD + pause/resume + force-fire + run history; forwards into the Flue agent dispatch path (create/update/delete/pause/resume mutate the row + syncCron; run calls fireNow which dispatches). ?wait=1 polls the runId to terminal.

src/db.ts
  Flue persistence adapter entrypoint.
  Uses Flue's Node sqlite() adapter for canonical agent sessions, durable direct/dispatch submissions, and event streams.
  Supplies SQLite workflow run and run registry records through SIM-ONE Alpha's persistence wrapper.
  Wraps the Flue session store to maintain logical session indexes, direct agent instance indexes, persisted normalized event context, and extracted session-memory FTS records.
  Exposes a shared LanceDB vector store and embedding client used by session memory, document index, and knowledge base retrieval.

src/api/routes/telemetry.ts
  Protected app-owned telemetry inspection routes.
  Exposes sanitized Flue event summaries by workflow run id.
  Falls back to persisted Flue run events when the in-memory telemetry observer no longer has the run.

src/core/schemas/
  Shared Valibot schemas for structured runtime contracts.
  Owned by the subsystem that defines the shape; promoted here only when the schema is reused across files or subsystems.
  Example: `src/core/schemas/coding-worker.ts` holds `CodingImplementerResultSchema` and the derived `CodingImplementerResult` type, used by the implementer subagent tool, the delegation path in `src/engine/workers/coding-worker/workflow/coordination.ts`, and re-exported from `src/engine/workers/coding-worker/types.ts`.

src/core/telemetry/flue-telemetry.ts
  Registers Flue observe(...) once per running application context.
  Stores sanitized live event summaries in memory by runId.
  Tracks whether a run delegated to the researcher and whether web_research was called.

src/agents/orchestrator.ts
  Main Flue orchestrator agent.
  Coordinates protocols, memory lookup, subagent delegation, and final synthesis.
  Composes its instructions from main workspace files plus a small runtime capability block.
  Registers the built-in `greeting-preflight` Agent Skill from `src/skills/greeting-preflight/SKILL.md`.
  Does not own web search.
  Directly owns `generate_image`, `record_image_artifact`, and `list_image_artifacts` for Runpod Public Endpoints image generation.

  Image generation tools backed by Runpod Public Endpoints.
  - `generate_image` calls Runpod, downloads the image, and saves it to `workspace/images/`.
  - `record_image_artifact` persists metadata to SQLite and indexes a memory summary.
  - `list_image_artifacts` queries prior artifacts from SQLite.
  - `models.yaml` is the human-editable model catalog copied into `.gorombo/sim-one-alpha/` and `.tmp/tsc/` at build time.

src/workspace/
  Main agent user-editable workspace persona files.
  Persona names and identity details live inside file contents, not architecture paths.

src/skills/greeting-preflight/SKILL.md
  Built-in Flue Agent Skill for connector startup greeting events.
  The Ratatui TUI sends a normal startup prompt that tells the orchestrator to use this skill with the preflight report.
  The skill is guidance only; executable preflight checks stay in the connector/gateway startup path.

src/engine/workers/researcher/researcher.ts
  Research subagent and direct researcher agent.
  Owns web research behavior.
  Composes its instructions from its workspace files plus a small runtime capability block.
  May use tools, skills, and workflows.

src/engine/workers/researcher/workspace/
  Researcher subagent user-editable workspace persona files.

src/engine/workers/coding-worker/coding-worker.ts
  Coding worker lead subagent profile.
  Owns coding-worker instructions, worker-local GitHub tools, coding-process skills, approval-aware side-effect boundaries, public progress event rules, and worker-local internal subagent profiles.
  The main orchestrator delegates coding work only to this lead profile.
  Receives the configured runtime workspace root from the orchestrator and passes it to worker-owned tools.

src/engine/workers/coding-worker/workspace/
  Coding worker user-editable workspace persona files.
  Documents the lead coding worker identity, principal hierarchy, tools, approval gates, verification rules, and progress expectations.

src/engine/workers/coding-worker/subagents/
  Worker-local internal coding subagents used only by the coding-worker lead.
  Includes triage, implementer, test-debug, code-review, and GitHub/PR specialists.
  These are not top-level orchestrator-addressable workers.

src/engine/workers/coding-worker/tools/
  Worker-local workspace/project, shell, git, GitHub, and approval-aware execution tools.
  Includes the LSP code-intelligence tools under `src/engine/workers/coding-worker/tools/code-intelligence/lsp/`.
  File/shell/git/test execution is backed by Flue's Node local sandbox factory.
  The sandbox is rooted at the configured runtime workspace root. By default this root is `src/workspace/` (the main agent persona workspace). User-editable workspace files live at that root; non-git projects live under `projects/**`; repositories live under `repos/**`.
  The coding worker must create or resolve new project work under that runtime workspace root.
  The main orchestrator does not own these tools directly.

src/engine/workers/coding-worker/subagents/<name>/workspace/
  Worker-local subagent user-editable workspace persona files.
  `USER.md` describes the coding-worker lead as the immediate principal, on behalf of the main orchestrator.

src/workspace-loader.ts
  Shared workspace markdown loader.
  Composes workspace files in a fixed order for agent instructions.
  Keeps user-editable workspace content separate from TypeScript agent entrypoints.

src/engine/commands/
  Pre-LLM slash command parsing and command registry helpers.
  Commands are application machinery; they are not sent to the LLM as prompts.

src/core/config/
  Typed loader and source JSON for the main SIM-ONE Alpha runtime config file.

.gorombo/sim-one-alpha/gorombo.config.json
  Built editable runtime config shipped with the product. Starts with primary and backup model card keys.

src/workflows/research.ts
  Finite direct research harness for testing or direct research runs.
  Initializes the researcher.

src/workflows/retrieval.ts
  Shared retrieval machinery.
  Web-search provider access is restricted to the researcher/research workflow caller boundary.
  Does not expose a public route.

src/workflows/web-research.ts
  Researcher-owned web research workflow.
  Handles query planning, basic/standard/deep research depth, cache, web search, fetch, evidence packing, confidence, and failures.
  Used by the researcher-owned web_research tool.

src/engine/tools/protocol-tool.ts
  Orchestrator-safe protocol loading tool.

src/engine/capabilities/
  Runtime capability registry subsystem. SQLite-backed user/agent-added
  capability store (skills, tools, workers, MCP). `capability-store.ts`
  owns CRUD; `capability-loader.ts` reads enabled rows at orchestrator init;
  `skill-materializer.ts` copies/github-clones user skill dirs into Flue's
  discovery path; `mcp-broker.ts` connects MCP servers and returns tools.
  Loaded at `createAgent(...)` init in `src/agents/orchestrator.ts`. See
  `docs/architecture/capability-system.md` and `scripts/capability-admin.mjs`.
  `tool-loader.ts` and `worker-loader.ts` dynamically `import()` user JS
  modules that export `defineTool(...`/`defineAgentProfile(...)` results.

scripts/capability-admin.mjs
  CLI admin script for capability CRUD (add/list/enable/disable/remove/update).
  Follows the `protocol-admin.mjs` pattern. Writes to SQLite at
  `.gorombo/db/capabilities.sqlite` and materializes skill/tool/worker
  files under `.gorombo/capabilities/`.

src/engine/tools/memory-tool.ts
  Orchestrator-safe memory lookup tool.
  Uses persisted session-memory FTS records and LanceDB vector embeddings extracted from Flue SessionData.
  Combines keyword and semantic search for hybrid retrieval.

src/engine/memory/structured-memory-note-index.ts
  LanceDB-backed semantic index over session-note content. Embeds title+content on upsert, deletes on archive, and supports semantic search merged with the engine keyword index via RRF (Decision 5). Graceful keyword-only fallback when no embedding client is configured.

src/engine/memory/structured-memory-database.ts
  Durable SQLite storage for structured-memory records. TS owns the schema: the full record is stored as JSON with scope denormalized into indexed columns. Feeds `reconcile_index` on cold start and runs the retention cleanup job.

src/engine/memory/structured-memory-runtime.ts
  Lazy singleton that loads the MemoryEngine (WASM, falling back to in-memory when the artifact is absent or in test mode), runs cold-start cleanup + hydration, and wraps mutations in `PersistingMemoryEngine` so every create/update/delete is durably persisted. Exposes the `ChecklistMemoryProvider`.

src/engine/memory/checklist-memory-provider.ts
  Structured-memory RAG provider. Surfaces checklists/todos/session notes as `RetrievedContext` (provider `structured-memory`) with rank, scope isolation (derived from the trusted `RagQuery`), and token-budget truncation.

src/engine/memory/memory-router.ts
  Multi-provider memory router. Fans `retrieve` out to registered providers (session memory under `memory`, structured memory under `structured-memory`) and merges with reciprocal rank fusion.

src/engine/memory/rust-memory-engine.ts
  TypeScript shim for the `gorombo-memory` WASM engine. Exposes `RustMemoryEngine` (loads the WASM, asserts version, calls exports, maps `Err(String)` prefixes to typed `MemoryEngineError`) and `InMemoryMemoryEngine` (pure-TypeScript parity reference for unit tests). The shim owns ids/timestamps/audit fields; the WASM owns validation, indexing, and query planning.

src/engine/tools/knowledge-tool.ts
  Orchestrator-safe knowledge writing tool.
  Embeds and stores agent-captured knowledge in the vector knowledge base.

src/engine/tools/web-research-tool.ts
  Researcher-owned web research tool.
  Accepts bounded research controls such as depth, freshness, query/fetch budgets, and context budgets.

src/engine/tools/memory-checklist-tools.ts
  Orchestrator-owned Flue tools for checklist CRUD (create/update/add_item/update_item/move/archive/list). Scope is derived from the trusted eventId; model-facing parameters omit scope/audit.

src/engine/tools/memory-todo-tools.ts
  Orchestrator-owned Flue tools for todo CRUD (create/update/complete/cancel/list).

src/engine/tools/memory-note-tools.ts
  Orchestrator-owned Flue tools for session-note CRUD (store/update/archive/list).

src/engine/tools/memory-search-tools.ts
  Orchestrator-owned keyword/tag search across structured memory, returning RetrievedContext with provider `structured-memory`.

src/engine/workers/coding-worker/tools/coding-task-memory-tools.ts
  Worker-local memory tool aliases (`coding_task_*`). `projectId` is injected from `CodingWorkspaceTargetInput`; every mutating write is recorded as an audit-only `memory.write`/`memory.handoff` event on `SharedCodingApprovalService` (never blocking). Includes `coding_task_handoff_plan_to_checklist` (Decision 9 cross-run handoff). Lead-only - not exposed to internal subagents.

src/engine/tools/rag-tool.ts
  Researcher-only low-level retrieval tool.
  Not attached to the orchestrator.

src/engine/workers/researcher/research/
  Researcher-owned research cache and web-provider wrappers.

src/core/models/providers/
  Provider registration and provider-owned model cards.
  Providers resolve env bindings declared by their cards.
  Providers with multiple cards store them in their own cards/ subdirectory.

src/core/models/catalog.ts
  Aggregates provider-owned cards and resolves Flue model specifiers.

src/core/models/runtime.ts
  Model-provider runtime bootstrap.
```

## Orchestrator Boundary

Allowed orchestrator capabilities:

```text
load_protocols
retrieve_memory
task delegation to researcher/coding/future workers
final synthesis
```

Forbidden orchestrator capabilities:

```text
web_search
web_fetch
retrieve_context when it can select web-search
direct RAG router web provider access
old non-Flue orchestrator routes
```

## Research Boundary

The researcher owns:

```text
web_research
query planning
one-search versus multi-search decisions
source/page cache
web search
web fetch
source comparison
confidence
provider failure reporting
structured findings
```

The researcher may implement that behavior through tools, skills, and workflow files.

## app.ts Contract

`src/app.ts` must stay close to:

```ts
import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';
import './core/models/runtime.js';
import { requireApiSecret } from './api/middleware/api-secret.js';
import { registerChatEventRoutes } from './api/routes/chat-events.js';
import { registerTelemetryRoutes } from './api/routes/telemetry.js';
import { registerFlueTelemetryObserver } from './core/telemetry/flue-telemetry.js';

registerFlueTelemetryObserver();

const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));

app.use('/agents/*', requireApiSecret);
app.use('/workflows/*', requireApiSecret);
app.use('/runs/*', requireApiSecret);
registerChatEventRoutes(app);
registerTelemetryRoutes(app);
app.route('/', flue());

export default app;
```

Custom ingress may be added only if it enters the Flue agent/workflow path.

The built HTTP chat path enters the durable orchestrator agent route:

```text
POST /api/chat/events
-> persist normalized event context in SQLite
-> POST /agents/orchestrator/:sessionId?wait=result
-> 200 { result, streamUrl, offset, event, session }
```

Async connector-style delivery should use Flue `dispatch(...)` against the orchestrator agent instance. Direct prompts and dispatched inputs share Flue's durable agent submission lifecycle when the Node runtime uses the SQLite `src/db.ts` adapter.
