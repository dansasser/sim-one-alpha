# Source Map

Use this page as a change-oriented navigation map. It is not a full file inventory; it points to the first places future humans and agents should inspect for common work.

## Runtime and app boundary

Start with:

- `src/app.ts`
- `src/agents/orchestrator.ts`
- `docs/architecture/flue-architecture.md`
- `docs/architecture/gorombo-flue-map.md`
- `AGENTS.md`

Keep `src/app.ts` limited to Hono setup, middleware, imported routes, telemetry observer boot, and `flue()` routing. Runtime composition belongs in the orchestrator agent and domain modules, not in the app entrypoint.

## Chat, sessions, and ingress

Start with:

- `src/api/routes/chat-events.ts`
- `src/api/routes/chat-prompt.ts`
- `src/api/connectors/web-api.ts`
- `src/engine/session/session-routing.ts`
- `src/engine/session/durable-orchestrator-session.ts`
- `src/engine/session/session-budget.ts`

Run route/session tests when changing this area. Watch for GUI-managed connector behavior, slash command handling, normalized event recording, and durable session access checks.

## Orchestrator and workers

Start with:

- `src/agents/orchestrator.ts`
- `src/workspace/`
- `src/engine/workers/researcher/`
- `src/engine/workers/coding-worker/`

The orchestrator coordinates and delegates. Researcher owns web/source-backed work. Coding-worker owns coding work and worker-local tooling. Do not call worker internals from the orchestrator when Flue task delegation is the intended boundary.

## Workflows and retrieval

Start with:

- `src/workflows/retrieval.ts`
- `src/workflows/web-research.ts`
- `src/workflows/research.ts`
- `src/engine/rag/`
- `src/engine/workers/researcher/research/`

Web search is caller-gated. Preserve provider failure metadata, cache behavior, context packing, and source evidence shape when refactoring.

## Capabilities and MCP

Start with:

- `docs/architecture/capability-system.md`
- `src/engine/capabilities/`
- `src/engine/tools/capabilities-tool.ts`
- `scripts/capability-admin.mjs`
- `sim-one-cli/src/cli.tsx`

Skills are instructions. Tools, workers, and MCP servers may execute code or external calls, so enablement and approval behavior matters. Runtime capability loading happens at orchestrator initialization.

## Protocols

Start with:

- `src/core/protocols/`
- `src/engine/tools/protocol-tool.ts`
- `scripts/protocol-admin.mjs`
- `src/tests/protocol-provider.test.ts`
- `src/tests/protocol-tool.test.ts`

Protocols are SQLite-backed runtime rules, not skills. The orchestrator must load protocols before final reasoning, tool use, delegation, or response generation.

## Memory and durable task state

Start with:

- `docs/architecture/memory-system.md`
- `src/engine/memory/`
- `src/engine/tools/memory-*.ts`
- `src/engine/workers/coding-worker/tools/coding-task-memory-tools.ts`
- `crates/gorombo-memory/`
- `scripts/smoke-memory-helper.mjs`

Scope is trusted context, not model input. If touching the Rust/WASM boundary or SQLite durability, run Rust, WASM, and smoke checks in addition to unit tests.

## Schedules

Start with:

- `docs/architecture/schedules-system.md`
- `src/engine/schedules/`
- `src/engine/tools/schedule-tools.ts`
- `src/api/routes/schedules.ts`
- `src/engine/workers/coding-worker/tools/coding-schedule-tools.ts`

Schedules dispatch to the orchestrator and observe terminal status through Flue events. Owner scope is derived from trusted event context for non-create operations.

## Models, config, and schemas

Start with:

- `src/core/config/`
- `src/core/models/`
- `src/core/schemas/`
- `docs/architecture/model-system.md`
- `docs/architecture/schema-strategy.md`
- `docs/architecture/session-context-budget.md`

Model cards declare environment variable names, not secret values. Prefer shared input parsing utilities from `src/core/utils/input.ts` over ad hoc parsing.

## CLI and TUI

Start with:

- `sim-one-cli/src/cli.tsx`
- `sim-one-cli/src/App.tsx`
- `sim-one-cli/src/launcher/`
- `sim-one-cli/src/commands/`
- `scripts/test-tui-e2e.mjs`

The default TUI session id is `primary`. Product-flow docs describe target install/service behavior; verify source before claiming a command is currently implemented.

## Connectors and external surfaces

Start with:

- `src/channels/telegram.ts`
- `src/api/routes/telegram-admin.ts`
- `src/api/routes/knowledge.ts`
- `src/api/routes/approval-routes.ts`
- `src/api/routes/telemetry.ts`

External connector routes should respect auth middleware and avoid exposing secret or raw content-bearing data accidentally.

## Documentation and product wording

Start with:

- `AGENTS.md`
- `README.md`
- `docs/architecture/product-flow.md`
- `openwiki/quickstart.md`

The current `README.md` is modified and scaffold-like in this working tree. Prefer source and architecture docs for current behavior, and mark target product items as target state unless source verifies them.
