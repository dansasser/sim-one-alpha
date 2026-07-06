# SIM-ONE Alpha OpenWiki Quickstart

## What this repository is

SIM-ONE Alpha is a Flue-based orchestrating agent runtime for a protocol-governed AI employee system. The product identity is explicit in `/AGENTS.md`: Gorombo is the company, SIM-ONE Alpha is the product, Flue is the TypeScript agent harness, and Ollie is a workspace persona rather than an architecture or path name.

The live runtime is a Node/TypeScript Flue application. `src/app.ts` creates the Hono app, registers app-owned HTTP routes, protects sensitive routes with API-secret middleware, starts telemetry observation, and mounts Flue routes with `app.route('/', flue())`. `src/agents/orchestrator.ts` is the main Flue `createAgent(...)` entrypoint. It selects a model from project model cards, composes workspace instructions, attaches built-in tools, connects built-in and user MCP tools, loads user tools/workers from the capability store, and exposes the built-in `researcher` and `coding-worker` subagents.

The repository also contains a separate Ink/React CLI package in `sim-one-cli/`, a Rust/WASM structured memory crate in `crates/gorombo-memory/`, developer scripts in `scripts/`, and existing architecture references under `docs/architecture/`.

## Start here

Read these OpenWiki pages in order when joining the project:

- [Runtime architecture](architecture/runtime.md) for the Flue/Hono app boundary, orchestrator, workers, workflows, sessions, auth, and telemetry.
- [Data and capabilities](architecture/data-and-capabilities.md) for SQLite-backed stores, protocol loading, structured memory, capabilities, schedules, approvals, model config, and RAG.
- [Product and agent workflows](workflows/product-and-agent-workflows.md) for current user-facing flows, target product flow, chat events, researcher/coding-worker ownership, Telegram, schedules, and CLI behavior.
- [Development and testing](operations/development-and-testing.md) for local commands, builds, tests, memory/WASM checks, and change-specific verification.
- [Source map](source-map.md) for where future agents should start when changing common areas.

The existing docs under `docs/architecture/` are still primary technical references. OpenWiki is the opinionated map and synthesis layer over those docs plus the current source.

## Current state versus target state

Some documents describe the intended installed product, while the source shows the currently wired developer/runtime state.

Currently wired in source:

- Flue gateway app and protected HTTP routes in `src/app.ts` and `src/api/routes/`.
- Durable orchestrator agent in `src/agents/orchestrator.ts`.
- Built-in tools for protocols, memory, knowledge, schedules, image artifacts, Telegram reply, and capability management.
- Built-in `researcher` and `coding-worker` subagents.
- Runtime-extensible capabilities backed by SQLite and materialized into user capability directories.
- Structured memory through TypeScript shims plus the Rust/WASM `gorombo-memory` crate, with SQLite durability and fallback behavior.
- Web research workflow owned by the researcher path in `src/workflows/web-research.ts`.
- Ink-based `sim-one` CLI package in `sim-one-cli/` with TUI launch and capability subcommands.

Target/product-flow items documented in `docs/architecture/product-flow.md` include the installer script, first-run wizard, web UI, and full service-management commands. Treat those as product direction unless matching source exists.

## Repository map

- `src/app.ts` - Hono app composition, route registration, auth middleware attachment, telemetry observer boot, Flue route mount.
- `src/agents/orchestrator.ts` - main Flue agent profile and runtime capability merge point.
- `src/api/` - middleware, connector normalization, and app-owned API routes for chat events, approvals, knowledge, schedules, telemetry, and Telegram admin.
- `src/channels/` - external channel integration, currently including Telegram.
- `src/core/` - config, model/provider runtime, schemas, protocols, telemetry, shared types, and input utilities.
- `src/engine/` - domain systems for approvals, capabilities, commands, embeddings, memory, RAG, registries, schedules, sessions, skills, tools, and workers.
- `src/workflows/` - finite Flue workflows for retrieval and research.
- `src/workspace/` - user-editable main agent workspace instructions and persona content.
- `sim-one-cli/` - separate CLI/TUI package for the `sim-one` binary.
- `crates/gorombo-memory/` - Rust structured-memory engine compiled to WASM.
- `scripts/` - developer admin, build, smoke, and test scripts.
- `docs/architecture/` - source-of-truth architecture docs for Flue boundaries, product flow, memory, capabilities, schedules, models, schema strategy, tools, and context budgets.
- `.gorombo/` - runtime artifact/config seed area used by build and package scripts.

## Common developer commands

Use `pnpm` with Node `>=22.18.0` as declared in `package.json`.

```sh
pnpm install
pnpm run typecheck
pnpm run test:unit
pnpm run build
pnpm run test:http
pnpm run test
```

Other useful commands from `package.json`:

```sh
pnpm run dev
pnpm run connect
pnpm run build:cli
pnpm run build:all
pnpm run test:tui
pnpm run smoke:http
pnpm run wasm:build
pnpm run smoke:memory
pnpm run cargo:test
```

The built server runs with:

```sh
pnpm run start
```

`start` executes `node --env-file=.env .gorombo/sim-one-alpha/server.mjs`. Do not read `.env`; use `.env.example` only as a non-secret configuration template.

## Change guidance for agents

Before changing Flue runtime boundaries, read `docs/architecture/flue-architecture.md` and `docs/architecture/gorombo-flue-map.md`. The repo intentionally keeps orchestration out of `src/app.ts`; the app file should stay limited to Hono setup, imported route registration, telemetry observer boot, auth middleware wiring, and `flue()` routing.

Before changing product wording, keep names distinct: Gorombo is the company, SIM-ONE Alpha is the product, Flue is the framework, `sim-one` is the product binary, and worker names are internal subsystems.

Before changing memory, capabilities, schedules, model cards, or worker delegation, use the relevant OpenWiki section and source docs as a checklist, then run the focused tests listed in [Development and testing](operations/development-and-testing.md).

## Git and local-change notes

This initial wiki was created with HEAD at `549a87771badae694409cc9535b6dd1740fb0ac3`. The working tree already had modified `README.md` and `pnpm-workspace.yaml`, plus untracked `docs/archive/`, before OpenWiki edits. Those local changes were treated as user-owned evidence and not reverted.
