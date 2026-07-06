# Runtime Architecture

## Runtime boundary

SIM-ONE Alpha is a Flue application wrapped by a small Hono app. `src/app.ts` is intentionally thin: it imports model/runtime bootstrapping and schedule boot side effects, registers telemetry observation, creates a Hono app, exposes `/health`, applies API-secret middleware to Flue and protected schedule routes, registers app-owned API route modules, and finally mounts Flue with `app.route('/', flue())`.

Do not put orchestration logic in `src/app.ts`. The local architecture contract in `docs/architecture/flue-architecture.md` says this file may own Hono setup, health checks, middleware, custom ingress, telemetry observer registration, and the Flue route mount. Agent business logic, RAG routing, web search, and provider wiring belong elsewhere.

## Main agent

`src/agents/orchestrator.ts` is the durable main Flue `createAgent(...)` entrypoint. It:

- calls `configureRuntimeModels(env)` and uses the selected model card specifier,
- composes workspace instructions from `src/workspace/` via `workspace-loader.ts`,
- sets compaction from `src/engine/session/context-budget.ts`,
- attaches built-in tools from `src/engine/tools/index.ts`,
- creates built-in `coding-worker` and `researcher` subagents,
- loads enabled user capabilities from SQLite through `src/engine/capabilities/`,
- connects built-in and user MCP servers,
- merges user tools and workers into Flue `tools` and `subagents`.

The orchestrator routes, loads protocols, retrieves memory when useful, delegates specialized work, and synthesizes responses. It should not directly own web research or coding execution. The runtime capability block in `src/agents/orchestrator.ts` is a useful source of truth for what is actually attached.

## Workers and delegation

Workers live under `src/engine/workers/`, not beside the main agent. The currently wired built-in workers are:

- `src/engine/workers/researcher/` for source-backed research and web retrieval.
- `src/engine/workers/coding-worker/` for coding work, local tool use, approvals, verification, and worker-local subagents.

The main orchestrator delegates to workers through Flue task delegation. Workspace instructions in `src/workspace/` define when the orchestrator should delegate; worker workspace files under each worker directory define internal worker guidance.

The architecture docs and orchestrator runtime block are explicit that current/external/web/source-backed work belongs to the `researcher`, and coding work belongs to `coding-worker`.

## HTTP ingress and sessions

`src/api/routes/chat-events.ts` is the app-owned chat ingress. It normalizes web API messages, parses supported slash commands, resolves or creates durable chat sessions, records normalized message events through `goromboPersistenceRuntime.sessionDatabase`, and forwards ordinary messages into Flue with:

```text
/agents/orchestrator/:sessionId?wait=result
```

Supported command handling includes `/new` and `/compact`. GUI-managed connectors do not use `/new`; the route returns a command response that points callers to client session controls.

Session routing and access rules live under `src/engine/session/`, especially `session-routing.ts`, `durable-orchestrator-session.ts`, `session-budget.ts`, and `context-budget.ts`. Recent history moved Flue-contract files back to top-level `src/` paths and removed shims, so prefer the current `src/agents`, `src/workflows`, `src/db.ts`, and `src/channels` locations.

## Workflows

Flue workflows are finite application-controlled operations in `src/workflows/`:

- `research.ts` for research workflow compatibility/entry behavior.
- `retrieval.ts` for provider-based context retrieval.
- `web-research.ts` for bounded source-backed research with query planning, cache-aware web search, optional page fetch, source packing, confidence, and provider-failure reporting.

Workflow HTTP invocation is asynchronous in Flue by default; route clients generally receive a run id and inspect `/runs/:runId`. Chat sessions are durable agent sessions, not workflow runs.

## Models and providers

Model/provider setup is centralized under `src/core/models/`. Model cards define provider id, model id/specifier, capabilities, context/output budgets, and environment variable names. Cards must not contain secret values. Provider runtime resolves those declared environment variable names at runtime.

When changing model selection, context budgets, compaction, or provider setup, read `docs/architecture/model-system.md` and `docs/architecture/session-context-budget.md` first.

## Auth and telemetry

`src/app.ts` protects `/agents/*`, `/workflows/*`, `/runs/*`, and `/api/schedules/*` with `requireApiSecret`. Route modules may also apply `requireApiSecret` directly for app-owned endpoints. Local/product auth expectations are described in `docs/architecture/product-flow.md`: loopback TUI access is intended to be local, while external connectors use `API_SECRET` via `x-api-secret`.

Telemetry observer boot is in `src/app.ts` through `registerFlueTelemetryObserver()` from `src/core/telemetry/flue-telemetry.ts`, and API exposure is in `src/api/routes/telemetry.ts`. Keep telemetry routes sanitized and avoid exposing raw content-bearing events unless the owning route explicitly handles that risk.

## Source references

- `src/app.ts`
- `src/agents/orchestrator.ts`
- `src/api/routes/chat-events.ts`
- `src/engine/session/`
- `src/engine/workers/`
- `src/workflows/`
- `docs/architecture/flue-architecture.md`
- `docs/architecture/gorombo-flue-map.md`
- `docs/architecture/session-context-budget.md`
