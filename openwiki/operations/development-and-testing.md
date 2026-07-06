# Development And Testing

## Local setup

This repository is a pnpm workspace with a Node runtime and a Rust/WASM memory crate. `package.json` declares Node `>=22.18.0` and `pnpm@10.10.0`.

Typical developer setup:

```sh
pnpm install
pnpm run typecheck
pnpm run test:unit
pnpm run build
pnpm run test:http
```

The full default test command is:

```sh
pnpm run test
```

It runs unit tests, builds the Flue runtime, then runs built HTTP tests.

## Build and run commands

Important scripts from `package.json`:

```sh
pnpm run dev              # flue dev --target node
pnpm run build            # flue build + builtin registry + runtime config + WASM artifact copy
pnpm run start            # node --env-file=.env .gorombo/sim-one-alpha/server.mjs
pnpm run connect          # flue connect orchestrator local --target node --session local
pnpm run build:cli        # build sim-one-cli package
pnpm run build:all        # build runtime, build CLI, launch built CLI
```

Do not read `.env`. Use `.env.example` and architecture docs for non-secret setup shape.

## Test commands

Core checks:

```sh
pnpm run typecheck
pnpm run test:unit
pnpm run build
pnpm run test:http
pnpm run smoke:http
```

CLI and TUI checks:

```sh
pnpm run build:cli
pnpm run test:tui
```

Memory/Rust/WASM checks:

```sh
pnpm run wasm:build
pnpm run smoke:memory
pnpm run cargo:test
```

Targeted scripts:

```sh
pnpm run test:lsp
pnpm run research:local
pnpm run protocols:seed
pnpm run protocols:list
pnpm run capabilities:list
```

## Test organization

Tests live under `src/tests/`. The suite is broad and mostly source-adjacent by domain rather than by framework layer.

High-signal tests by change area:

- App routes and HTTP behavior: `http-endpoints.test.ts`, `api-secret-loopback.test.ts`, `chat-prompt.test.ts`.
- Architecture boundaries: `architecture-contract.test.ts`, `flue-internal-compat.test.ts`, `flue-session-store.test.ts`.
- Models and config: `models.test.ts`, `gorombo-config.test.ts`, `memory-config.test.ts`, `schedules-config.test.ts`.
- Protocols: `protocol-provider.test.ts`, `protocol-tool.test.ts`.
- Capabilities: `capability-store.test.ts`, `builtin-registry.test.ts`, `worker-loader.test.ts`.
- Memory: `memory-*-tools.test.ts`, `structured-memory-*.test.ts`, `rust-memory-engine.test.ts`, `checklist-memory-provider.test.ts`, `schemas-memory.test.ts`.
- Research/RAG: `retrieval-workflow.test.ts`, `web-research-workflow.test.ts`, `web-research-tool.test.ts`, `research-agent.test.ts`, `research-cache.test.ts`, `document-index-provider.test.ts`, `ollama-web-search-provider.test.ts`.
- Schedules: `schedule-manager.test.ts`, `schedules-store.test.ts`, `schedules-routes.test.ts`, `schedules.test.ts`, `coding-schedule-tools.test.ts`.
- Coding worker: `coding-worker.test.ts`, `coding-task-handoff.test.ts`, `coding-task-memory-tools.test.ts`, `coding-worker-internal-subagents.test.ts`, `code-intelligence.test.ts`, `lsp-tools.test.ts`, `verification-parsers.test.ts`.
- Telegram and approvals: `telegram-connector.test.ts`, `telegram-approval-ui.test.ts`, `approval-ingress.test.ts`, `shared-approval-service.test.ts`.
- Images/artifacts: `runpod-image-tool.test.ts`.

`src/tests/coding-worker.test.ts` is large and covers many coding-worker behaviors. Prefer narrower tests when a change maps cleanly to a focused file, then run the broader worker test when touching shared worker loops or tools.

## CI-relevant recent history

Recent commits added CLI build and TUI e2e testing to CI, fixed fork-PR handling for TUI tests, and fixed web research fallback/test behavior around missing `OLLAMA_API_KEY`. When changing `.github/workflows/ci.yml`, CLI startup, or web research, preserve these CI constraints.

Recent commits also moved Flue-contract files back to top-level `src/` paths and removed shims. Avoid recreating old paths such as `src/engine/agents/orchestrator.ts` or `src/engine/workflows/*` unless there is a deliberate migration plan.

## Change-specific guidance

When changing `src/app.ts`, run route and architecture tests. Verify the file stays limited to Hono setup, middleware, imported route registration, telemetry observer boot, and `flue()` routing.

When changing `src/agents/orchestrator.ts`, run architecture, protocol, capability, session, and worker delegation tests as applicable. Check that the runtime capability block stays accurate.

When changing web research, run `web-research-tool.test.ts`, `web-research-workflow.test.ts`, `retrieval-workflow.test.ts`, and any researcher-agent tests. Pay attention to provider failure propagation and fetch behavior when optional provider credentials are absent.

When changing memory, run unit memory tests plus `pnpm run cargo:test`. If touching WASM load/copy paths or SQLite durability, also run `pnpm run wasm:build` and `pnpm run smoke:memory`.

When changing capabilities, run `capability-store.test.ts`, `worker-loader.test.ts`, `builtin-registry.test.ts`, and CLI build/tests if the `sim-one` command surface changes.

When changing schedules, run schedule store/manager/routes/config tests and any coding schedule tool tests.

When changing the CLI/TUI, run `pnpm run build:cli` and `pnpm run test:tui`. The default session id should remain `primary` unless product behavior intentionally changes.

## Operational cautions

- Do not document or expose secret values from `.env` or local runtime databases.
- User runtime data lives under `~/.gorombo/` by product convention; repository `.gorombo/` contains build/runtime artifacts and config seeds.
- Capability, memory, protocol, and schedule data are runtime state. Be careful with migration behavior and backward compatibility.
- The README is currently modified and contains release-scaffold placeholders, so source and architecture docs are stronger evidence for current behavior.
