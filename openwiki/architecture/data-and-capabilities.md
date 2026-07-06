# Data And Capabilities

## Persistence runtime

`src/db.ts` is the shared persistence bootstrap. It loads `gorombo.config.json` through `src/core/config/gorombo-config.ts`, creates the session/persistence runtime with `src/engine/session/session-persistence.ts`, and reconciles configured capabilities into the capability SQLite store before requests use the agent.

The main durable data areas are:

- chat/session persistence under `src/engine/session/`,
- capability records in `~/.gorombo/db/capabilities.sqlite` by default,
- structured memory records in SQLite through the memory runtime,
- protocol records in SQLite through protocol tooling,
- schedule records and run history through the schedules system,
- research caches and RAG/vector stores where configured.

Do not read or document live `.env` values. Use `.env.example` and architecture docs for non-secret setup shape.

## Capabilities

The capability system lets users add skills, tools, workers, and MCP servers without rebuilding the product artifact. The source of truth is `docs/architecture/capability-system.md` plus `src/engine/capabilities/`.

`src/engine/capabilities/capability-store.ts` creates and manages a SQLite table with `(kind, id)` as the primary key, a unique id index, enabled state, source metadata, config JSON, install/update timestamps, and install origin. The default DB path is `~/.gorombo/db/capabilities.sqlite`, overrideable with `GOROMBO_CAPABILITY_DB_PATH`.

Runtime loading happens during orchestrator initialization in `src/agents/orchestrator.ts`:

- `loadUserCapabilities()` reads enabled records grouped by kind.
- `materializeCapability()` prepares user skill/tool/worker files.
- `connectBuiltinMcpServers()` and `connectUserMcpServers()` return MCP tools.
- `loadUserTools()` imports user tool modules.
- `loadUserWorkers()` imports user worker profiles.
- The orchestrator merges user tools into `tools` and user workers into `subagents`.

Skills are instruction assets. Tools, workers, and MCP servers can execute code or external calls, so approval and enablement behavior matters. CLI/user-initiated operations and agent-initiated operations are different trust contexts; check `docs/architecture/capability-system.md` and `src/engine/tools/capabilities-tool.ts` before changing this area.

## Protocols

Protocols are runtime rule records, not skills. Top-level `AGENTS.md` states that the orchestrator must call the Protocol Tool on every orchestration call before final reasoning, tool execution, worker delegation, or response generation.

Protocol implementation lives under `src/core/protocols/` and `src/engine/tools/protocol-tool.ts`; tests include `src/tests/protocol-provider.test.ts` and `src/tests/protocol-tool.test.ts`. Protocol lookup can consider connector, user, client, project, task, workflow, message type, priority, and enabled status. Keep mandatory runtime rules in protocols rather than skill markdown.

## Structured memory

Structured memory provides durable checklists, todos, and session notes. The architecture reference is `docs/architecture/memory-system.md`.

The stack is:

```text
agent tools
-> TypeScript memory engine interface/shim
-> Rust/WASM gorombo-memory engine, with TypeScript fallback for tests and missing artifacts
-> Persisting memory wrapper
-> SQLite durable store
-> retrieve_memory provider and memory tools
```

Important source areas:

- `crates/gorombo-memory/` owns the Rust data model, validation, indexing, scope matching, and WASM exports.
- `src/engine/memory/rust-memory-engine.ts` loads the WASM and includes an in-memory parity engine.
- `src/engine/memory/structured-memory-runtime.ts` initializes durable memory, hydrates from SQLite, and reconciles after persistence failures.
- `src/engine/tools/memory-*.ts` expose orchestrator memory tools.
- `src/engine/workers/coding-worker/tools/coding-task-memory-tools.ts` exposes coding-worker memory tools with worker-trusted scope.

Scope is a trust boundary. Tools derive scope from trusted events or worker context; the model should not supply actor, conversation, project, thread, or global scope directly.

## RAG and web research

Retrieval is centered in `src/workflows/retrieval.ts` and provider code under `src/engine/rag/`. Web research is owned by the researcher path, not the orchestrator. `src/workflows/web-research.ts` builds a bounded query plan, uses cache-aware search/fetch providers, packs unique contexts to a token budget, returns source evidence, and reports provider failures.

Recent git history fixed web research event dependency and fallback propagation, and tests around `src/tests/web-research-tool.test.ts` were updated to avoid requiring `OLLAMA_API_KEY` for fetch-call assertions. Treat web search ownership and fallback handling as regression-sensitive.

## Schedules

Schedules are booted by `src/engine/schedules/boot.ts` via the side-effect import in `src/app.ts`. App-owned schedule routes are registered from `src/api/routes/schedules.ts`, and schedule tools are attached in `src/agents/orchestrator.ts`.

Read `docs/architecture/schedules-system.md` before changing schedule records, owner scope enforcement, run history, or route behavior. Relevant tests include `src/tests/schedule-manager.test.ts`, `src/tests/schedules-store.test.ts`, `src/tests/schedules-routes.test.ts`, `src/tests/schedules-config.test.ts`, and `src/tests/coding-schedule-tools.test.ts`.

## Approvals

Approval routes live in `src/api/routes/approval-routes.ts`. Approval services and shared approval behavior live under `src/engine/approvals/` and worker-specific approval integration under `src/engine/workers/coding-worker/`.

Recent documentation history called out approval gating as an important review finding. For changes that allow code execution, external connections, memory writes, or worker actions, inspect the approval path and add focused tests such as `approval-ingress.test.ts`, `shared-approval-service.test.ts`, or worker approval tests.

## Models, config, and schemas

Configuration loads from `src/core/config/`, model/provider runtime from `src/core/models/`, and schemas from `src/core/schemas/`. Architecture docs include:

- `docs/architecture/model-system.md`
- `docs/architecture/schema-strategy.md`
- `docs/architecture/session-context-budget.md`

Model cards describe provider env var names, but not secret values. Schema and input parsing helpers are used to keep tool/workflow inputs bounded; prefer those shared utilities over ad hoc parsing.

## Source references

- `src/db.ts`
- `src/core/config/`
- `src/core/models/`
- `src/core/protocols/`
- `src/engine/capabilities/`
- `src/engine/memory/`
- `src/engine/rag/`
- `src/engine/schedules/`
- `src/engine/approvals/`
- `crates/gorombo-memory/`
- `docs/architecture/capability-system.md`
- `docs/architecture/memory-system.md`
- `docs/architecture/schedules-system.md`
