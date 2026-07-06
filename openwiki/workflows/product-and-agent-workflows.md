# Product And Agent Workflows

## Product identity and business domain

SIM-ONE Alpha is positioned as a protocol-governed AI employee runtime. The core business idea is governance: the orchestrator coordinates work, loads applicable protocols, uses durable memory, delegates specialized tasks, validates results, and responds through connected surfaces.

Use the naming rules in `/AGENTS.md` consistently:

- Gorombo is the company.
- SIM-ONE Alpha is the product/runtime.
- Flue is the TypeScript agent framework.
- `sim-one` is the product CLI binary.
- Workers are internal subsystems, not public products.
- Persona names belong in workspace contents, not architecture paths.

## Current gateway flow

The current runtime gateway is the built Flue/Hono server. The source-backed flow is:

```text
connector or HTTP client
-> app-owned Hono route or Flue route
-> normalized message event
-> durable chat/session persistence
-> orchestrator Flue agent session
-> protocol loading and optional memory retrieval
-> tool use or worker delegation
-> response returned to caller or channel
```

`src/app.ts` registers route modules for chat events, knowledge, schedules, telemetry, approvals, and Telegram admin before mounting Flue runtime routes.

## Chat event flow

`src/api/routes/chat-events.ts` handles `/api/chat/events` and `/api/chat/sessions`. The event flow is:

1. Parse JSON and normalize the incoming message through `normalizeWebApiMessage()`.
2. Parse slash commands with `src/engine/commands/slash-commands.ts`.
3. Resolve durable session routing through `src/engine/session/session-routing.ts`.
4. Record the normalized event in `goromboPersistenceRuntime.sessionDatabase`.
5. Handle `/new` or `/compact` directly when applicable.
6. Forward ordinary messages to `/agents/orchestrator/:sessionId?wait=result` with a chat prompt created by `src/api/routes/chat-prompt.ts`.
7. Add event and session metadata to JSON responses.

Session access denial returns 403. Invalid JSON returns 400. Unknown slash commands are recorded and returned as handled command responses.

## Protocol-governed orchestration

The orchestrator must call `load_protocols` before final reasoning, tool execution, worker delegation, or response generation. Protocols are SQLite-backed runtime rules, not skills.

When delegating to `coding-worker`, the orchestrator runtime instructions require parsing the `load_protocols` result and including the parsed object as `protocolBundle` in the delegated task input. This keeps worker execution under the same runtime governance model.

## Research workflow

The researcher owns current, external, web, source-backed, and research tasks. The orchestrator should decide that research is needed and delegate to the `researcher` subagent rather than directly calling web search.

`src/workflows/web-research.ts` implements bounded web research. It supports research depth, freshness, query and fetch limits, context-token budgets, provider failures, confidence, and cache statistics. It calls `retrieveContext()` with `caller: 'researcher'` and provider `web-search`.

Relevant tests include:

- `src/tests/web-research-workflow.test.ts`
- `src/tests/web-research-tool.test.ts`
- `src/tests/research-agent.test.ts`
- `src/tests/research-workflow.test.ts`
- `src/tests/retrieval-workflow.test.ts`

Recent history fixed web research event dependency and fallback propagation, so preserve those behaviors when refactoring.

## Coding workflow

The coding worker is created in `src/engine/workers/coding-worker/coding-worker.ts` and attached by `src/agents/orchestrator.ts`. The orchestrator delegates coding work to `coding-worker`; it should not call coding-worker internals directly.

The coding worker owns coding-specific tools, approval service integration, task memory, code intelligence/LSP behavior, verification parsing, GitHub-related capabilities, and worker-local subagents. Representative tests include:

- `src/tests/coding-worker.test.ts`
- `src/tests/coding-task-handoff.test.ts`
- `src/tests/coding-task-memory-tools.test.ts`
- `src/tests/coding-worker-internal-subagents.test.ts`
- `src/tests/code-intelligence.test.ts`
- `src/tests/lsp-tools.test.ts`
- `src/tests/verification-parsers.test.ts`

When changing coding behavior, check the worker workspace and approval paths before changing the main orchestrator.

## Capability management workflow

Capabilities can be managed by developer scripts, agent tools, and the `sim-one` CLI package.

Current source surfaces:

- `scripts/capability-admin.mjs` for developer/admin CRUD.
- `src/engine/tools/capabilities-tool.ts` for orchestrator-visible capability management tools.
- `sim-one-cli/src/cli.tsx` for product CLI subcommands.
- `src/engine/capabilities/` for SQLite store, loaders, materializers, MCP broker, user tools, and user workers.

The current `sim-one` CLI declares `skill`, `tool`, `worker`, and `mcp` subcommands with add/list/enable/disable/remove/update behavior. Skills default to enabled on add; tools/workers/MCP default to disabled unless enabled explicitly.

## CLI and TUI workflow

`sim-one-cli/src/cli.tsx` defines the `sim-one` binary. With no subcommand, it launches the Ink TUI. It can connect to a provided `--base-url`, or start/ensure a local server through `sim-one-cli/src/launcher/server-manager.ts`. The default session id is `primary`, reflecting recent history that renamed the default from `proto`.

`package.json` exposes:

```sh
pnpm run build:cli
pnpm run build:all
pnpm run test:tui
```

`build:all` builds the runtime, builds the CLI package, and launches `.gorombo/sim-one-cli/cli.js`. This is a developer workflow, not the final installed product flow.

## Telegram and connector workflow

Telegram integration is under `src/channels/telegram.ts` with admin routes in `src/api/routes/telegram-admin.ts`. The orchestrator has a `telegram_reply` tool when `TELEGRAM_BOT_TOKEN` is configured.

Tests include `src/tests/telegram-connector.test.ts` and `src/tests/telegram-approval-ui.test.ts`. Recent history moved Telegram from the previous `src/api/channels/` path to `src/channels/`, so use the current path.

## Schedule workflow

Schedules are agent-turn triggers and recurring/one-shot jobs. The boot side effect is imported by `src/app.ts`, routes are registered from `src/api/routes/schedules.ts`, and schedule tools are attached to the orchestrator.

Schedule operations enforce owner scope from trusted event ids for non-create operations. Before changing schedule behavior, read `docs/architecture/schedules-system.md` and run the focused schedule tests listed in [Development and testing](../operations/development-and-testing.md).

## Target product flow caveat

`docs/architecture/product-flow.md` describes the target product install and use experience: `sim-one.sh`, first-run wizard, always-on gateway, web UI, service management, and unified `sim-one` command. Some parts are implemented today, especially the gateway, capability store, and CLI package. Other parts are product direction. When documenting or coding, distinguish current source behavior from target flow.

## Source references

- `docs/architecture/product-flow.md`
- `docs/architecture/orchestrator-flow.md`
- `src/app.ts`
- `src/api/routes/chat-events.ts`
- `src/api/routes/chat-prompt.ts`
- `src/agents/orchestrator.ts`
- `src/workflows/web-research.ts`
- `src/engine/workers/`
- `src/engine/capabilities/`
- `src/channels/telegram.ts`
- `sim-one-cli/src/cli.tsx`
