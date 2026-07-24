# SIM-ONE Alpha

SIM-ONE Alpha is a Flue-based agent project for building practical AI Employees, business automation workflows, research assistants, coding workers, connected chat experiences, and operational AI systems.

It is built on [Flue](https://flueframework.com), a TypeScript agent harness framework from the Astro ecosystem.

SIM-ONE Alpha adds its own protocol system, memory layer, RAG architecture, registry-driven tools, registry-driven skills, registry-driven workers, Telegram/API connectors, and business workflow patterns on top of Flue.

The goal is simple:

> Build agents that can do useful work, retrieve the context they need, follow rules, use tools, and coordinate specialized workers without turning every task into one giant prompt.

## Features

- Flue-based TypeScript agent foundation
- Telegram and Web/API connector support
- Secure Web API / Gateway layer
- SQLite-backed protocol system
- Database-backed memory layer
- RAG architecture with memory, web search, and document-index support (document-index provider is a placeholder)
- Registry-driven tools
- Built-in Flue Agent Skills plus registry-driven user skills
- Registry-driven workers/subagents
- Runtime-extensible capability model
- Coding worker with plan / implement / test-debug / review / GitHub subagents and approval-gated repo mutations
- Business-focused AI Employee architecture
- Runpod Public Endpoints image generation tool (`generate_image`) attached directly to the main orchestrator
- Production Ratatui TUI with clean startup preflight, durable sessions, styled Markdown responses, and orchestrator-owned greeting behavior

## Why Flue

SIM-ONE Alpha is built with Flue because Flue provides the programmable agent harness layer needed for real agent workflows.

Flue gives the project a foundation for:

- agents
- sessions
- tools
- skills
- workflows
- filesystem access
- sandboxed execution
- deployable runtimes

SIM-ONE Alpha builds on that foundation with:

- protocols
- memory
- retrieval
- registries
- connectors
- business workflows
- worker orchestration

Flue provides the harness.

SIM-ONE Alpha defines the operating system built on top of it.

## About Gorombo

SIM-ONE Alpha is built by [Gorombo](https://gorombo.com), a governance-first AI software company since 1999.

Gorombo's mission: better AI comes from better governance, not bigger models.

- Website: https://gorombo.com
- Founder/CEO: Daniel T Sasser II

## How It Works

Messages enter the system through Telegram, Web/API, scheduled jobs, or future connectors.

Those messages are normalized and passed into the agent system through the Secure Web API / Gateway.

The agent then loads applicable protocols, retrieves memory or outside context when needed, uses tools, delegates to workers when appropriate, validates the result, and returns a response.

Basic flow:

```text
Connector
-> Secure Web API / Gateway
-> Normalized Message Event
-> Agent
-> Protocol Tool
-> Memory / RAG
-> Tools / Workers
-> Validation
-> Response
```

## Core Systems

### Protocols

Protocols are runtime rules.

Protocols are not skills.

Protocols are stored in SQLite and loaded through a protocol tool.

The protocol system gives the agent applicable rules before it responds, uses tools, or delegates work.

Examples of protocol records may include:

- global rules
- connector rules
- client rules
- project rules
- workflow rules
- task rules
- output rules
- safety rules

### Memory

Memory is a first-class architecture layer. Protocols provide rules; memory provides context.

Structured memory is implemented as durable **checklists, todos, and session notes** that survive across long-running tasks and process restarts. The data model, scope matching, and query/scoring logic live in a Rust crate (`crates/gorombo-memory/`) compiled to WebAssembly via `wasm-pack`; a thin TypeScript shim (`src/engine/memory/rust-memory-engine.ts`) loads the WASM module and delegates every create/update/delete/query to it. A pure-TypeScript `InMemoryMemoryEngine` mirrors the same contract as a parity reference for unit tests.

- **Durable store:** every mutation is persisted to SQLite (default `.gorombo/db/structured-memory.sqlite`); the WASM in-memory index is hydrated from the durable store on cold start via `reconcile_index`.
- **Scope is truth, never from the model:** scope (`actorId`/`conversationId`/`projectId`/`threadId`) is derived from a trusted persisted `NormalizedMessageEvent` (`eventId`) for orchestrator tools, and injected from the worker context for coding-worker tools. Update operations verify the target record's scope matches before mutating.
- **Retrieval:** surfaced through `retrieve_memory` alongside session memory and RAG, ranked and truncated to the context budget.

See [Memory Helper (Structured Memory)](#memory-helper-structured-memory) for the full architecture, configuration, and smoke commands.

### RAG

RAG gives the agent access to knowledge outside the current prompt.

The RAG architecture provides:

- memory retrieval (structured memory + session memory via FTS + LanceDB vector search)
- web search (Ollama Search provider)
- project file indexing (background indexer)
- LanceDB vector store for semantic retrieval
- embedding fallback chain (Ollama Cloud → bundled ONNX local model)

RAG is accessed through the `retrieve_context` tool (researcher-only) and the `retrieve_memory` tool (orchestrator). The RAG router fans queries to registered providers and merges results with reciprocal rank fusion. The document-index provider is a placeholder for future document retrieval integration.

### Tools

Tools are executable capabilities.

A tool does something.

Examples:

- load protocols
- search memory
- query a database
- call an external API
- search documents
- search the web
- send a Telegram message
- retrieve project context
- create a draft
- run validation
- generate an image with Runpod Public Endpoints (`generate_image`)
- record image metadata (`record_image_artifact`)
- list prior image artifacts (`list_image_artifacts`)

Tools are discovered through the Tool Registry.

Native Flue tools can exist in the codebase, but runtime-extensible tools should be exposed through a registry wrapper or gateway.

### Skills

Skills are reusable workflow knowledge.

A skill describes how to perform a process.

Skills may reference tools.

Skills may guide the agent or workers.

Skills are not protocols and do not store mandatory runtime rules.

The coding worker ships with 5 built-in skills:

- `code-change-loop` — the lead coding loop (plan → implement → test → review → github)
- `code-review-loop` — code review subagent workflow
- `github-pr-loop` — GitHub PR creation and management workflow
- `triage-loop` — task triage and decomposition workflow
- `ci-debug-loop` — CI failure diagnosis workflow

Skills are extensible at runtime via the capability registry (see [Capability Model](#capability-model--two-tier-extensibility) below).

### Workers

Workers are specialized executors.

Workers may run independently or be called by the main agent.

Built:

- **Research Worker** — owns web research, source-backed investigation, query planning, cache, and evidence packing. Delegated via the Flue `task` tool with `agent: "researcher"`.
- **Coding Worker** — owns coding work with 5 internal subagents (triage, implementer, test-debug, code-review, github). Approval-gated repo mutations. Delegated via `agent: "coding-worker"`. The main orchestrator exposes only the lead; internal subagents are not visible to the orchestrator.

Roadmap:

- Writing Worker
- Testing / Review Worker
- Future Domain Workers

Workers return structured results and do not silently mutate global state.

### Registries

Registries make the system extensible.

Core registries include:

- Tool Registry
- Skill Registry
- Agent / Worker Registry
- Protocol Access Layer

The registry system allows the project to support both base capabilities and user-defined capabilities without hardcoding every future tool, skill, or worker directly into the agent.

### Connectors

Connectors normalize external communication into internal message events.

Connectors do not contain orchestration logic.

Built:

- **Telegram** — bot receives messages, dispatches to orchestrator, sends replies
- **Web/API** — HTTP endpoints for external integrations and the TUI
- **Scheduled Jobs** — cron-style triggers via Croner that dispatch to the orchestrator

Roadmap:

- Discord
- Future connectors

Web chat is a client of the Secure Web API.

The Secure Web API is the backend ingress point.

### Capability Model — Two-Tier Extensibility

SIM-ONE Alpha has two ways to add capabilities (skills, tools, workers, MCP servers):

**1. Flue-native (build-time / developer):** When developing from source, Flue gives you build-time discovery. You add agents, workflows, channels, skills, and tools by writing TypeScript files in `src/agents/`, `src/workflows/`, `src/channels/`, and `src/engine/tools/`. Flue discovers these at build time and compiles them into the server. This is how all built-in capabilities are defined — the orchestrator, researcher, coding-worker, memory tools, protocol tool, schedule tools, image generation tools, MCP servers.

**2. SIM-ONE Alpha capability registry (runtime / user + agent):** SIM-ONE Alpha adds a layer on top of Flue. After you build or install the final product, users and the agent itself can add skills, tools, workers (subagents), and MCP servers at runtime through the capability registry — no rebuild needed. The capability store in SQLite persists these. At agent init, capabilities are materialized from SQLite into Flue's discovery paths and merged with built-in capabilities. The agent can self-extend via `add_skill` (auto-enables, no approval needed), `add_tool`, `add_worker`, `add_mcp_server` (require user approval via CLI or TUI before activation — they are added with `enabled=0` until approved, since they execute arbitrary code). Users can add via `sim-one` CLI subcommands or the developer `capability-admin.mjs` script.

Both tiers coexist: built-in capabilities (defined in code) and user-defined capabilities (stored in SQLite) merge into the same `tools`, `skills`, and `subagents` arrays at agent init. Collision detection prevents name conflicts between the two tiers.

The runtime registry is what makes SIM-ONE Alpha extensible as a product — users don't need to write code or rebuild to add capabilities. When developing from source, you have both options available.

See [Capability Management](#capability-management) below for CLI commands and source directory structures.

## Example Workflows

### General Chat

```text
User
-> Connector
-> Gateway
-> Agent
-> Protocol Tool
-> Memory / RAG
-> Response
```

### Telegram Interaction

```text
Telegram
-> Telegram Connector
-> Normalized Message Event
-> Secure Web API / Gateway
-> Agent
-> Response
-> Telegram
```

### Research Task

```text
User Request
-> Agent
-> Protocol Tool
-> Memory Tool
-> RAG Router
-> Web Search / Docs / Repos
-> Research Worker if needed
-> Validated Answer
```

### Memory Retrieval Task

```text
User Request
-> Agent
-> Protocol Tool
-> Memory Tool
-> Memory DB / Document Index
-> Retrieved Context
-> Response
```

### Coding Task

```text
User Request
-> Agent
-> Protocol Tool
-> Coding Worker
-> Sandbox
-> Tests
-> Diff
-> Review
-> Response / Approval
```

### Business Automation Task

```text
User Request
-> Agent
-> Protocol Tool
-> Memory / RAG
-> Tool Registry
-> Business Tool
-> Validation
-> Response
```

## Technology Stack

Core stack:

```text
TypeScript
Flue
SQLite
Rust (WASM) — structured-memory engine
LanceDB — vector store
Node.js
```

Primary storage roles:

```text
SQLite      = protocol storage, Flue persistence, session state, structured memory
Rust/WASM   = structured-memory engine (checklists, todos, session notes)
LanceDB     = vector search (session memory, session notes, knowledge/project-file index)
```

## Project Structure


```text
src/
  agents/            # Flue-contract: orchestrator entrypoint (Flue discovers here)
  channels/          # Flue-contract: provider ingress (e.g. Telegram)
  workflows/         # Flue-contract: finite Flue operations (research, retrieval, web-research)
  db.ts              # Flue-contract: persistence adapter entrypoint
  app.ts             # Flue-contract: Hono application shell
  core/              # cross-cutting foundations
    config/          # runtime config loaders + shipped gorombo.config.json
    models/          # model cards, provider registration, registry, runtime bootstrap
    protocols/       # protocol schemas + SQLite protocol provider
    schemas/         # shared Valibot schemas for structured-output contracts
    telemetry/       # sanitized Flue event capture and run summaries
    types/           # shared TypeScript contracts
    utils/           # generic helpers
  api/               # external interfaces and transport
    connectors/      # telegram, web-api normalizers
    ingress/         # approval ingress modules
    middleware/      # Hono middleware (API-secret auth)
    routes/          # HTTP routes (chat, approval, telemetry, schedules, ...)
  engine/            # AI/Agentic logic and orchestration
    approvals/       # shared approval service
    capabilities/    # runtime capability registry (SQLite store, loaders, MCP broker)
    commands/        # pre-LLM slash command parsing
    embeddings/      # bundled ONNX embedding model + tokenizer
    memory/          # structured-memory shim, SQLite store, providers (Rust/WASM engine lives in crates/)
    rag/             # retrieval, embeddings, vector store, indexers
    registries/      # tool / skill / agent registries
    schedules/       # scheduled/recurring/one-shot agent execution (Croner + SQLite)
    session/         # session persistence, compaction, context budget
    skills/          # extensible skills slot (user-added at runtime)
    tools/           # orchestrator-owned tools (memory, research, protocols, schedules, image gen, ...)
    workers/         # coding worker + researcher + subagents + tools
  workspace/         # main agent persona files
  tests/             # test suite
crates/
  gorombo-memory/    # Rust structured-memory engine -> WASM (wasm-pack)
```

## Installation

### Prerequisites

There are two distinct requirement sets depending on how you obtain SIM-ONE Alpha:

#### Runtime requirements (running a finished install)

These apply to end users running a packaged install (the eventual `sim-one` install package, or a pre-built `.gorombo/sim-one-alpha/` artifact):

- **Node.js >= 22.18.0** — required by Flue (native TypeScript config support). Use `nvm use 22` or set `PATH` to the Node 22 binary.

That's it. The structured-memory WASM engine ships pre-compiled inside `.gorombo/sim-one-alpha/`, so no Rust toolchain, no `wasm-pack`, and no build step is needed at runtime.

#### Build-from-source requirements (cloning and building this repo)

These apply to developers cloning this repository to build from source:

- **Node.js >= 22.18.0** — required by Flue (native TypeScript config support). Use `nvm use 22` or set `PATH` to the Node 22 binary.
- **pnpm 10.x** — the repo uses pnpm (declared in `packageManager`). Install via `npm install -g pnpm` or Corepack.
- **Rust toolchain + wasm-pack** — required for building the structured-memory WASM engine from source. Install via [rustup](https://rustup.rs/) and `cargo install wasm-pack --version 0.13.1`. The `prebuild` script runs `wasm-build.mjs` which needs `wasm-pack` on `PATH`.

> **Why Rust is a build-time dependency only:** The structured-memory engine is a Rust crate (`crates/gorombo-memory/`) compiled to WebAssembly via `wasm-pack`. Once built, the resulting `.wasm` artifact lives in `.gorombo/sim-one-alpha/memory/` and is loaded by Node at runtime — no Rust compiler, `cargo`, or `wasm-pack` needed on the host running the server. The `prebuild` script only invokes the Rust toolchain to produce the `.wasm`; the finished `.gorombo/sim-one-alpha/` is self-contained and can be copied to a machine without Rust installed and run there.

### Setup

```sh
git clone https://github.com/dansasser/sim-one-alpha.git
cd sim-one-alpha
pnpm install
```

### Environment

Copy the example env file and set provider secrets:

```sh
cp .env.example .env
```

Key environment variables (see `.env.example` for the full list):

| Variable | Required | Purpose |
| --- | --- | --- |
| `API_SECRET` | No (external only) | Shared secret for external HTTP API auth (`x-api-secret` header). Required only for external connectors (Telegram, web API). Local TUI connections over loopback bypass auth. |
| `OLLAMA_API_KEY` | No | Ollama Cloud API key. Enables cloud embeddings and web search. Without it, the bundled local ONNX model is used for embeddings. |
| `RUNPOD_API_KEY` | No | Runpod Public Endpoints API key. Enables image generation tools. |
| `TELEGRAM_BOT_TOKEN` | No | Telegram bot token. Enables the Telegram connector. Without it, the server runs in TUI/HTTP-only mode. |
| `GOROMBO_APPROVAL_ROOT` | No | Directory for approval persistence. Required for coding-worker side-effect approvals. |

All other env vars are optional and documented in `.env.example`.

### Embedding model (one-time)

Download the bundled local embedding model (90MB, gitignored — required for local RAG without an Ollama API key):

```sh
pnpm fetch-embedding-model
```

After downloading, RAG works without Ollama running and without any API keys. The system tries the cloud provider first when `OLLAMA_API_KEY` is configured, and falls back to the bundled `all-MiniLM-L6-v2` ONNX model automatically.

### Build

```sh
# Build the runtime (Flue server → .gorombo/sim-one-alpha/)
pnpm run build

# Build the Ratatui TUI binary
pnpm run build:tui:ratatui

# Build the product CLI wrapper (tsup → .gorombo/sim-one-cli/)
pnpm run build:cli

# Build runtime + Ratatui TUI + CLI and verify sim-one is runnable
pnpm run build:all
```

`pnpm run build` compiles the WASM memory engine (the `prebuild` step invokes `wasm-pack` — this is what requires the Rust toolchain), builds the Flue Node server (`.gorombo/sim-one-alpha/server.mjs`), copies the runtime config, and copies the WASM artifact into `.gorombo/sim-one-alpha/`. The resulting `.gorombo/sim-one-alpha/` is self-contained: you can copy it to a machine without Rust installed and run the server from there. Only rebuilding the WASM from source requires the toolchain.

`pnpm run build:tui:ratatui` compiles the Rust/Ratatui terminal client into `.gorombo/sim-one-ratatui/sim-one-ratatui-tui` (or `.exe` on Windows).

`pnpm run build:cli` compiles the TypeScript product wrapper into `.gorombo/sim-one-cli/cli.js` and writes the runnable launchers `.gorombo/sim-one-cli/sim-one` and `.gorombo/sim-one-cli/sim-one.cmd`.

`pnpm run build:all` builds the runtime, Ratatui binary, and CLI wrapper, then checks that the packaged `sim-one` command is runnable.

### Launch the TUI

```sh
# Launch the product TUI from the build output
./.gorombo/sim-one-cli/sim-one
```

This one command:
1. Resolves and launches `.gorombo/sim-one-ratatui/sim-one-ratatui-tui`
2. Checks if the gateway is already running (health check on `127.0.0.1:<port>`)
3. If not running, starts it from `.gorombo/sim-one-alpha/server.mjs` with env from `.env`
4. Waits for the gateway to become healthy
5. Opens the Ratatui interface over loopback (no auth header needed)
6. On exit, kills only a gateway child that this TUI started

The port is read from `gorombo.config.json` (`gateway.port`, default 3940). Override with `--port`:

```sh
./.gorombo/sim-one-cli/sim-one --port 3960
```

To connect to an already-running remote server (skip server lifecycle):

```sh
./.gorombo/sim-one-cli/sim-one --base-url http://192.168.0.131:3940
```

### Start the server alone

```sh
# Using the built artifact
pnpm start
# or: node --env-file=.env .gorombo/sim-one-alpha/server.mjs

# Custom port
PORT=3960 node --env-file=.env .gorombo/sim-one-alpha/server.mjs
```

The server takes ~30 seconds to start (ONNX model load blocks the event loop). Wait for `[flue] Server listening` in the log before sending requests.

### Development mode

```sh
pnpm run dev
```

Starts `flue dev --target node` which watches source files, rebuilds on changes, and restarts the server automatically. Default port is 3583.

### Run tests

```sh
pnpm test              # unit tests + build + HTTP smoke tests
pnpm run test:unit     # unit tests only
pnpm run typecheck     # TypeScript type checking
pnpm run test:tui      # built server + CLI e2e smoke
pnpm run test:tui:ratatui # packaged sim-one/Ratatui product smoke
```

## Interactive TUI

SIM-ONE Alpha includes a Ratatui terminal UI for chatting with the agent, viewing live progress rows, rendering assistant Markdown with terminal-native styles, managing durable sessions, and keeping prompt input usable while the transcript scrolls. The TUI is a connector client. It sends prompts and backend-owned slash commands to `/api/chat/events` as connector `tui`; the Flue gateway owns orchestration, model calls, tools, workers, protocols, memory, and compaction.

The TypeScript `sim-one` wrapper owns product command routing and capability subcommands. No-argument `sim-one` launches the Rust/Ratatui binary.

### What the TUI shows

- **Transcript/context pane** — `SIM-ONE Alpha` header with an explicit session name when present, prompts, assistant responses, stream activity, tool/status rows, and local system notices
- **Prompt editor** — wrapped multiline input up to five visible rows, vertical arrow navigation, `\` then Enter for a newline, cursor and word movement, Home/End, delete/backspace, Ctrl+U, and submit
- **Command palette** — type `/` to filter and select session/TUI commands from a six-row keyboard- and mouse-driven drop-up
- **Status bar** — gateway URL, active session id or explicit name, stream state, pending response state, elapsed thinking time, and spinner
- **Session command output** — `/new`, `/clear`, `/resume`, `/rename`, `/compact`, `/session`, `/sessions`, `/help`, and `/exit`
- **Mouse text editing** — click or drag in the prompt, drag-copy logical transcript text, and use OSC52 clipboard delivery without disabling mouse capture
- **Scroll behavior** — PgUp/PgDown scroll the transcript; mouse wheel, scrollbar, and palette events route to the pane under the pointer while arrows move through multiline prompt rows

### First run — the wizard (planned)

On first install, `sim-one install` (or the install script) will launch a wizard TUI that walks through:
- Model selection and API key entry
- Optional channel setup (Telegram, Discord, etc.)
- Optional initial capabilities (skills, tools, MCP servers)
- Persona/workspace configuration
- Gateway service launch (always-on background process)

> **Status:** The wizard (`sim-one install`) is planned for the next phase. The Ratatui TUI itself is working now — use `./.gorombo/sim-one-cli/sim-one` from a built worktree.

### Running the TUI

The product wrapper lives in `sim-one-cli/`. The terminal client lives in `tui/ratatui/`. During development, run from the built product output:

```sh
# From the build output (recommended)
./.gorombo/sim-one-cli/sim-one

# Resume one specific existing TUI session
./.gorombo/sim-one-cli/sim-one --session tui-2026-...

# Build all product artifacts
pnpm run build:all

# Capability management subcommands (from build output)
./.gorombo/sim-one-cli/sim-one skill list
./.gorombo/sim-one-cli/sim-one skill add /path/to/skill my-skill "My Skill" --enable
./.gorombo/sim-one-cli/sim-one mcp add my-mcp "My MCP" --url http://localhost:8080 --enable

# Capability management subcommands (from source, dev mode)
pnpm --filter sim-one-cli exec tsx src/cli.tsx skill list
pnpm --filter sim-one-cli exec tsx src/cli.tsx skill add /path/to/skill my-skill "My Skill" --enable
pnpm --filter sim-one-cli exec tsx src/cli.tsx mcp add my-mcp "My MCP" --url http://localhost:8080 --enable
```

A no-argument launch creates a fresh durable TUI session through `POST /api/chat/sessions`, attaches its Flue stream, and sends the startup greeting as that session's first normal prompt. It never resumes the last TUI session implicitly. Existing TUI context loads through an exact id or explicit name with `--session <selector>` at launch or `/resume <session-id-or-name>` inside the app. A missing launch selector falls back to a new session and greeting; denied or ambiguous selectors still fail closed. Telegram retains its own connector-conversation persistence policy; that policy does not apply to the TUI.

Explicit TUI resume restores prior visible prompts, settled public activity, and final root-assistant responses through the gateway's ownership-validated transcript projection before the live stream attaches. It does not send a second greeting or expose internal startup prompts, raw tool results, or nested worker response bodies. Ratatui consumes the returned snapshot and Flue `nextOffset`; it never reads runtime databases directly.

Core TUI slash commands:

```text
/new [title]           create a new durable TUI session and switch to it
/clear [title]         clear the active TUI thread by creating a new active session
/resume <session-id-or-name> resume an available durable session and switch to it
/sessions [limit]      list recent sessions, default 10, max 50
/session               show the current active session id
/rename <title>        rename the active durable session
/compact               compact the active durable Flue session
/help                  print the TUI command list
/exit                  close the TUI and print the active session id
```

Mouse controls are pane-aware. Transcript drag selection highlights logical rendered text and copies it without borders, margins, Markdown markers, or visual-wrap newlines. Prompt clicks place the cursor; prompt drags support copy, replacement, cut, and deletion across wrapped Unicode text. The transcript scrollbar supports track clicks and dragging, and the command palette supports wheel navigation, click selection, and outside dismissal. Host clipboard delivery uses OSC52 and may require multiplexer passthrough.

See:

- `docs/architecture/tui-cli-session-flow.md` for the implementation flow.
- `docs/architecture/product-flow.md` for the full product install and launch flow.
- `docs/tui/ratatui.md` for the user guide.
- `docs/tui/session-management.md` for session commands.
- `docs/operations/product-tui.md` for packaged runtime operations.

## Capability Management

The capability registry lets users and agents add skills, tools, workers (subagents), and MCP servers to a running SIM-ONE Alpha instance without rebuilding. By default, capabilities are stored in SQLite (`.gorombo/db/capabilities.sqlite`) and materialized into `.gorombo/capabilities/` (both relative to the project root, unless overridden with env vars). A service restart picks up changes — no rebuild needed.

### Product CLI

After install, manage capabilities with the `sim-one` binary:

> **Status:** The build output now includes `.gorombo/sim-one-cli/sim-one`. During development, use that path or the source command shown below. Installed systems will expose `sim-one` on PATH. See `docs/architecture/product-flow.md` for the full product flow.

```sh
# Add a skill from GitHub
sim-one skill add https://github.com/user/my-skill my-skill "My Skill" "Description" --enable

# Add a skill from a local directory
sim-one skill add /path/to/skill-dir my-skill "My Skill" --enable

# Add a tool (requires approval before enabling)
sim-one tool add https://github.com/user/my-tool my-tool "My Tool" "Description"

# Add a worker (requires approval before enabling)
sim-one worker add https://github.com/user/my-worker my-worker "My Worker" "Description"

# Add an MCP server
sim-one mcp add my-mcp "My MCP Server" --url http://localhost:8080 --description "Description" --enable

# List capabilities
sim-one skill list
sim-one tool list
sim-one mcp list
sim-one worker list

# Enable/disable (for tools/workers/MCP that require approval)
sim-one tool enable my-tool
sim-one tool disable my-tool

# Update (re-fetch from source — git pull or local copy)
sim-one skill update my-skill

# Remove (deletes SQLite row and capability files)
sim-one skill remove my-skill
```

After adding or enabling a capability, restart the service for it to take effect: `sim-one restart`

#### Developer-only tool (before `sim-one` binary ships)

During development, a standalone script provides the same CRUD operations:

```sh
# Add a skill from GitHub
node scripts/capability-admin.mjs add skill https://github.com/user/my-skill my-skill "My Skill" "Description" --enable

# Add a skill from a local directory (skills auto-enable by default)
node scripts/capability-admin.mjs add skill /path/to/skill-dir my-skill "My Skill"

# Add a tool (requires --enable to activate)
node scripts/capability-admin.mjs add tool https://github.com/user/my-tool my-tool "My Tool" "Description"

# Add an MCP server
node scripts/capability-admin.mjs add mcp my-mcp "My MCP Server" "Description" --url http://localhost:8080 --enable

# List capabilities
node scripts/capability-admin.mjs list

# Enable/disable
node scripts/capability-admin.mjs enable tool my-tool
node scripts/capability-admin.mjs disable tool my-tool

# Update (re-fetch from source)
node scripts/capability-admin.mjs update skill my-skill

# Remove
node scripts/capability-admin.mjs remove skill my-skill
```

This is a dev-time tool. The product interface is `sim-one skill add ...`, not pnpm scripts or standalone `.mjs` files.

### Agent tools

The orchestrator has model-callable tools for managing capabilities:
- `add_skill` — adds a skill (auto-enables, no approval needed)
- `add_tool` — adds a tool (requires user approval via CLI or TUI)
- `add_worker` — adds a worker (requires approval)
- `add_mcp_server` — adds an MCP server (requires approval)
- `list_capabilities` — lists all registered capabilities with status

### Config file mirror

`gorombo.config.json` supports a `capabilities` array that reconciles into SQLite at boot. This is additive — entries in config but missing from SQLite get inserted; existing entries are not overwritten.

```json
{
  "version": 1,
  "models": { "primary": "..." },
  "capabilities": [
    {
      "id": "my-skill",
      "kind": "skill",
      "name": "My Skill",
      "description": "...",
      "source": "github",
      "sourceRef": "https://github.com/user/my-skill",
      "enabled": true
    }
  ]
}
```

### Environment variables

- `GOROMBO_CAPABILITY_DB_PATH` — SQLite path (default: `.gorombo/db/capabilities.sqlite`)
- `GOROMBO_CAPABILITIES_DIR` — capability files root (default: `.gorombo/capabilities/`)

### Developer-only tools (not the product interface)

During development, before the `sim-one` binary ships, capability management is available via a standalone script:

```sh
node scripts/capability-admin.mjs add skill /path/to/skill my-skill "My Skill" --enable
node scripts/capability-admin.mjs list
node scripts/capability-admin.mjs enable tool my-tool
node scripts/capability-admin.mjs remove skill my-skill
```

These are dev-time tools. The product interface is `sim-one skill add ...`, not `pnpm` scripts or standalone `.mjs` files.

### Source directory structure

Each capability kind requires a specific directory structure. When you point `sim-one skill add <path>` or `sim-one tool add <path>` at a local directory or GitHub repo, the source must follow these shapes:

#### Skill

```text
my-skill/
  SKILL.md          # required — Agent Skills spec frontmatter + markdown body
```

`SKILL.md` frontmatter (per the [Agent Skills spec](https://agentskills.io/specification)):

```yaml
---
name: my-skill             # must match the directory name
description: Does X thing   # tells the agent when to use this skill
---
```

Skills are markdown-only (no code execution). They auto-enable — no approval needed. The `SKILL.md` and any supporting files in the directory are materialized into `~/.gorombo/capabilities/skills/<id>/`.

#### Tool

```text
my-tool/
  index.mjs         # required — exports a defineTool(...) result
```

`index.mjs` shape:

```js
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

export default defineTool({
  name: 'my_tool',
  description: 'Does X thing.',
  parameters: v.object({
    input: v.pipe(v.string(), v.description('The input value')),
  }),
  execute: async ({ input }) => {
    return `Result: ${input}`;
  },
});
```

Tools execute arbitrary code (in-process via dynamic `import()`). They require user approval before enabling. The `index.mjs` is materialized into `~/.gorombo/capabilities/tools/<id>/`.

You can also export multiple tools (array or named exports):

```js
// Array export
export default [toolA, toolB];

// Named exports
export const toolA = defineTool({ ... });
export const toolB = defineTool({ ... });
```

#### Worker (subagent)

```text
my-worker/
  index.mjs         # required — exports a defineAgentProfile(...) result
  workspace/        # required — worker persona files (same as built-in workers)
    USER.md          # worker identity, role, instructions
    TOOLS.md         # available tools for this worker
    ...other workspace files
```

`index.mjs` shape:

```js
import { defineAgentProfile } from '@flue/runtime';

export default defineAgentProfile({
  name: 'my-worker',
  description: 'A specialized worker for X.',
  instructions: 'Base instructions from the module.',
});
```

Workers are subagents — the orchestrator delegates to them via the Flue `task` tool. They require user approval before enabling. The worker loader reads the `workspace/` directory and loads persona files via `composeWorkspaceInstructions()`, merging them into the profile's `instructions` field alongside any instructions declared in the module.

If no `workspace/` directory exists, the worker loads with a warning — all workers should have workspace persona files.

The `workspace/` directory follows the same file conventions as built-in workers:

| File | Purpose |
| --- | --- |
| `USER.md` | Worker identity, role, behavior guidance |
| `TOOLS.md` | Available tools for this worker |
| `AGENTS.md` | System instructions (company-owned) |
| `IDENTITY.md` | Detailed identity definition |
| `SOUL.md` | Personality and tone |
| `MEMORY.md` | Memory usage guidance |
| `SECURITY.md` | Security boundaries |
| `HEARTBEAT.md` | Health check guidance |

Not all files are required — include the ones that make sense for the worker. `USER.md` is the minimum.

#### MCP server

MCP servers don't have a source directory — they're remote endpoints. You add them with connection details:

```sh
sim-one mcp add my-mcp "My MCP Server" \
  --url https://mcp.example.com/mcp \
  --transport streamable-http \
  --token-env MCP_TOKEN \
  --description "Description" \
  --enable
```

The `--token-env` flag names an environment variable (not the token value itself) that contains the auth token. The MCP broker reads it at runtime and passes it as a `Bearer` token in the `Authorization` header.

### Built-in MCP

SIM-ONE Alpha includes a built-in MCP connection to the Astro docs server (`https://mcp.docs.astro.build/mcp`). This gives the orchestrator access to `mcp__astro-docs__search_astro_docs` — a tool that searches Astro framework documentation. No setup required, always available.

The `astro-docs` name is reserved — users and agents cannot add a capability with that name (collision detection blocks it).

See `docs/architecture/astro-docs-mcp.md` for details and planned coding agent integration.

### Naming collision detection

When adding a capability, the system checks for name conflicts:
- **Built-in names** — tools, subagents, skills, and MCP servers that ship with SIM-ONE Alpha (e.g. `load_protocols`, `coding-worker`, `astro-docs`). The full list is generated at build time in `.gorombo/sim-one-alpha/builtin-capabilities.json`.
- **Existing capabilities** — any capability already registered in the SQLite store.

If a collision is found, the add is refused with an error: `Name 'X' conflicts with a built-in capability. Choose a different name.` or `Name 'X' already exists as a <kind> capability. Choose a different name.` The user or agent must pick a different name — no auto-rename.

See `docs/architecture/capability-system.md` for full architecture documentation and `docs/architecture/product-flow.md` for the product install and launch flow.

## Local Chat

Model choice lives in the shipped runtime config file. In source it is:

```text
src/core/config/gorombo.config.json
```

After build it is copied to:

```text
.gorombo/sim-one-alpha/gorombo.config.json
```

```json
{
  "version": 1,
  "models": {
    "primary": "minimax-m3-cloud",
    "backup": "codex-brain"
  }
}
```

Create a local `.env` from `.env.example` and set provider secrets only:

```env
OLLAMA_API_KEY=your_ollama_cloud_key_here
CODEX_BRAIN_LOCAL_API_URL=http://192.168.0.131:4180/v1
CODEX_BRAIN_LOCAL_API_KEY=your_codex_brain_key_here
API_SECRET=local_testing_secret
RUNPOD_API_KEY=your_runpod_key_here
```

The default primary and backup model cards use Ollama's direct cloud API:

```env
OLLAMA_API_KEY=your_key_here
OLLAMA_CLOUD_BASE_URL=https://ollama.com/v1
GOROMBO_WEB_SEARCH_PROVIDER=ollama
OLLAMA_WEB_SEARCH_BASE_URL=https://ollama.com
GOROMBO_RAG_MAX_CONTEXT_TOKENS=4000
GOROMBO_RAG_WEB_FETCH_TOP_K=1
```

Embedding provider chain:

```text
cloud (Ollama Cloud, if OLLAMA_API_KEY is set)
  ↓ on any failure
onnx-local (bundled all-MiniLM-L6-v2, 384-dim, no network)
  ↓ on any failure
local (legacy Ollama local /v1/embeddings)
```

`OLLAMA_API_KEY` is optional. Without it, the bundled local model is used. If the local model files are missing, run `pnpm fetch-embedding-model`. Pre-AVX x86 CPUs and GPU execution providers are not supported by the default installer.

Select another project-owned model card by changing the shipped `gorombo.config.json` runtime file and restarting the runtime:

```json
{
  "version": 1,
  "models": {
    "primary": "qwen3-5-cloud",
    "backup": "deepseek-v4-pro-cloud"
  }
}
```

Register the DT1-hosted Codex Brain model through its own provider when needed:

```env
CODEX_BRAIN_LOCAL_API_URL=https://dt1.example.local/v1
CODEX_BRAIN_LOCAL_API_KEY=your_codex_brain_key_here
```

Then select it by card key in `gorombo.config.json`.

`CODEX_BRAIN_LOCAL_API_URL` must be the OpenAI-compatible base URL including `/v1`.

Run a one-shot research workflow:

```sh
pnpm run research:local -- "Find the official Ollama web search API docs URL."
```

Open an interactive Flue agent session:

```sh
pnpm run connect
```

Start the built Node HTTP runtime:

```sh
pnpm run build
pnpm start
```

The HTTP runtime uses the Flue routing model:

- `GET /health` is public.
- `POST /api/chat/events` is the app-owned chat ingress alias.
- `GET /api/chat/sessions` lists stored chat sessions for HTTP clients.
- `POST /agents/orchestrator/:sessionId` is the durable Flue orchestrator agent route used by the chat ingress.
- `GET /runs/:runId` reads persisted Flue run and event stream records.

Protected routes require:

```text
x-api-secret: <API_SECRET>
```

`API_SECRET` is optional — only needed for external connectors (Telegram, web API). Local TUI connections over loopback (127.0.0.1) bypass the secret check entirely. If `API_SECRET` is missing and an external request hits a protected endpoint, it fails closed with `503`.

The app-owned chat ingress normalizes and authorizes the message, persists trusted event context to SQLite, resolves the product session, and prompts the durable orchestrator agent instance at `/agents/orchestrator/:sessionId?wait=result`. A successful normal chat event returns the direct agent result with stream coordinates:

```json
{
  "result": {},
  "streamUrl": "http://127.0.0.1:3000/agents/orchestrator/<sessionId>",
  "offset": "0",
  "event": { "id": "web-..." },
  "session": { "id": "<sessionId>", "surface": "web", "created": true }
}
```

Flue workflow HTTP invocation remains available for other finite workflow calls. Workflow calls return `202` with a `runId`; clients then read `/runs/:runId` with the same secret header to retrieve the completed workflow result.

The `/api/chat/events` durable ingress:

- Normalizes the incoming message event.
- Persists trusted event context before agent admission.
- Resolves the product session.
- Handles pre-LLM slash commands that can be handled at ingress.
- Prompts the durable `orchestrator` Flue agent instance for that session.

Model selection rules:

- `models.primary` and `models.backup` are project model card keys.
- Raw Flue specifiers and `GOROMBO_MODEL` env selection are rejected.
- The default primary card is `minimax-m3-cloud`, which resolves through its card to `ollama-cloud/minimax-m3` and calls Ollama Cloud through `https://ollama.com/v1`.
- The durable orchestrator agent uses the configured primary card. The backup card remains configured metadata for paths that explicitly implement fallback behavior.
- Model cards live inside each provider directory under `src/core/models/providers/<provider>/cards`.
- The catalog in `src/core/models/catalog.ts` aggregates cards for model selection and budget lookup.

The agent has tool flow wired for protocol loading, session-memory retrieval, and RAG/context retrieval. Protocols are live (SQLite-backed, loaded through the protocol tool). Web search is owned by the researcher subagent and is live through Ollama Search when an Ollama API key is configured. The document-index provider is a placeholder for future document retrieval integration.

## Model Cards

Model cards are the project-owned source of truth for models the agent can intentionally use.

Runtime model choice is separate from card definition. The shipped `gorombo.config.json` runtime file chooses active card keys:

```json
{
  "version": 1,
  "models": {
    "primary": "minimax-m3-cloud",
    "backup": "codex-brain"
  }
}
```

`.env` stores provider credentials. It must not choose models.

Each card lives under its owning provider directory, for example `src/core/models/providers/ollama-cloud/cards/minimax-m3.ts`, and owns the details that are specific to one model:

- provider id and model id
- Flue model specifier
- roles and capabilities
- context window limits
- maximum output tokens
- advertised, guaranteed, and provider-reported limits when those differ
- source notes for where the metadata came from

Provider files live next to their cards in `src/core/models/providers/<provider>`. Providers describe transport: base URLs, API key environment variables, Flue `registerProvider(...)` calls, and per-provider model registration. When a provider has multiple model cards, those cards live in that provider's `cards/` subdirectory. This keeps provider setup out of agent files and lets the agent reference a card by specifier.

Cards exist because session management, compaction, and RAG all need model-specific token limits. MiniMax M3, DeepSeek V4 Pro, and Qwen 3.5 do not have the same usable context or output budgets. The context-budget layer reads the selected card instead of hardcoding token limits in the agent, durable ingress, or RAG router.

Current cards:

```text
minimax-m3-cloud       -> ollama-cloud/minimax-m3
deepseek-v4-pro-cloud  -> ollama-cloud/deepseek-v4-pro
qwen3-5-cloud          -> ollama-cloud/qwen3.5:397b
codex-brain            -> codex-brain/gpt-5.5
```

MiniMax M3 is intentionally recorded with multiple limits: MiniMax advertises up to 1M context with a guaranteed 512K minimum, while Ollama Cloud currently reports 524288 through both direct cloud metadata and the local `:cloud` path. Session budget code must treat those as separate facts.

## Session Budget And Compaction

The durable chat ingress and session layer use card-driven context budget metadata for explicit compaction, session-memory indexing, and future RAG allocation.

Implemented pieces:

- `resolveModelCard(...)` maps a Flue model specifier back to a project model card.
- `calculateContextBudget(...)` chooses the provider-safe context window, reserves output tokens, and calculates warning, compaction, and hard-stop thresholds.
- `evaluateCompaction(...)` returns `normal`, `warn`, `compact`, or `stop`.
- `src/db.ts` exports the Flue persistence adapter discovered by Flue at build time.
- `session-persistence.ts` wraps Flue's built-in SQLite adapter and indexes latest logical workflow sessions plus durable direct-agent instance sessions.
- `session-database.ts` stores chat session catalog records, active connector sessions, persisted normalized event context, and session-memory FTS chunks.
- `deriveSessionBudgetStateFromData(...)` estimates budget from the stored Flue conversation tree, including compaction entries.
- `chatSessionBudgetStore` remains as an in-process fallback when stored session data is not available.
- The `/compact` slash command opens the durable direct-agent session and calls Flue `session.compact()` without sending the command text to the model.

Flue's native automatic compaction remains enabled on the orchestrator agent with card-derived `reserveTokens` and `keepRecentTokens`. The SIM-ONE Alpha layer adds explicit command compaction, persisted context lookup, and budget telemetry for future RAG allocation.

Session memory is now indexed from stored Flue `SessionData` and retrieved through the memory tool. The future full SIM-ONE Alpha memory stack is separate from this session-memory layer. Web search/document chunks should be injected only after the budget layer reports remaining context capacity.

Runtime SQLite defaults:

```text
.gorombo/db/flue.sqlite      Flue sessions, durable submissions, event streams, and workflow run/registry records
.gorombo/db/sessions.sqlite  chat sessions, active sessions, logical session indexes, normalized event context, and session-memory FTS
```

Protected telemetry uses live in-memory Flue observer summaries when available and can fall back to persisted Flue run events after the in-memory summary is gone.

Slash commands are parsed before the prompt reaches the LLM:

- `/new` starts a new trusted connector/TUI session. GUI-managed web chat should use the client new-chat control instead, and generic Web API payloads cannot opt into connector-only behavior by spoofing a connector name.
- `/clear` replaces the current TUI conversation with a fresh durable session while preserving the prior session for explicit resume.
- `/resume <session-id-or-name>` resumes an available durable TUI session after access checks. Exact duplicate names return a conflict instead of selecting one arbitrarily.
- `/rename <title>` renames the active durable TUI session.
- `/compact` calls Flue `session.compact()` for the resolved durable direct-agent session and returns command telemetry.

The Ratatui TUI also owns local commands that do not go to the model: `/session`, `/sessions [limit]`, `/help`, and `/exit`.

Architecture details live in `docs/architecture/session-context-budget.md` and `docs/architecture/tui-cli-session-flow.md`.

## Web Search And Research

Ollama Search is the default web-search provider for the researcher-owned web research path.

The provider uses the existing Ollama API key:

```env
GOROMBO_WEB_SEARCH_PROVIDER=ollama
OLLAMA_API_KEY=your_key_here
OLLAMA_WEB_SEARCH_BASE_URL=https://ollama.com
GOROMBO_RAG_MAX_CONTEXT_TOKENS=4000
GOROMBO_RAG_WEB_FETCH_TOP_K=1
GOROMBO_RESEARCH_MAX_QUERIES=3
GOROMBO_RESEARCH_MAX_FETCHES=2
GOROMBO_RESEARCH_CACHE_DB=.gorombo/db/research-cache.sqlite
```

Implemented endpoints:

```text
POST https://ollama.com/api/web_search
POST https://ollama.com/api/web_fetch
```

`web_search` results are normalized into the project `RetrievedContext` shape with `provider: "web-search"` and `metadata.provider: "ollama"`. If no Ollama key is configured, the web provider falls back to the web-search placeholder instead of failing startup.

The researcher-facing `web_research` tool calls the `web-research` Flue workflow boundary, which owns query planning, search/fetch budget, cache use, evidence packing, confidence, and provider failures. The low-level `retrieve_context` tool remains researcher-only and must not be attached to the orchestrator.

The researcher-owned web research path handles:

- query planning: one search for simple lookups, multiple searches for complex research/comparison prompts
- cache: per-run in-memory cache plus optional SQLite persistent cache
- search-to-fetch enrichment: `webFetch: "auto"` or `"always"` fetches top pages when the provider supports `fetchPage(...)`
- context packing: returned contexts are packed to `maxContextTokens`, defaulting to `GOROMBO_RAG_MAX_CONTEXT_TOKENS` or `4000`
- provider failures: web-search failures are returned in `providerFailures` instead of failing the whole chat path

The `web_research` tool accepts optional `limit`, `maxContextTokens`, `webFetch`, `maxQueries`, `maxFetches`, and `freshness` controls.

Future RAG providers such as local SearXNG, GitHub, company documents, and durable memory should plug into the same `RagProvider` interface and then be ranked by the retrieval workflow and RAG router.

## Research Subagent

The main orchestrator has a registered Flue subagent named `researcher`.

Use the boundaries this way:

- no web needed: main orchestrator may answer, use protocols, or use safe memory lookup
- any web/current/source-backed information: main orchestrator delegates through Flue `task` with `agent: "researcher"`
- low-level provider errors: the research workflow records failures in `providerFailures`
- research strategy: researcher decides which searches to run, when to fetch pages, when to stop, and how to compare sources

The researcher subagent lives in `src/engine/workers/researcher/researcher.ts` and owns the `web_research` tool. The standalone `research` workflow in `src/workflows/research.ts` initializes the researcher directly for CLI or API research runs. Use `pnpm run research:local -- "..."` for local one-shot research testing.

Main-agent workspace persona files live in `src/workspace/`. Subagent workspace persona files live beside their subagent implementation, for example `src/engine/workers/researcher/workspace/`. Persona names belong inside workspace file contents, not in architecture paths.

```text
durable chat ingress
-> orchestrator agent
-> task tool with agent: "researcher"
-> researcher subagent
-> web_research
-> web-research workflow
-> retrieval workflow
-> cache / Ollama Search / future RAG providers
```

## Configuration

Environment variables are used for secrets and service configuration.

The main agent runtime config is a real JSON file shipped with the product:

```text
src/core/config/gorombo.config.json -> source
.gorombo/sim-one-alpha/gorombo.config.json       -> built/package runtime file
```

It starts with model selection and is intended to grow into the deployment-level config for the agent:

```json
{
  "version": 1,
  "models": { "primary": "minimax-m3-cloud", "backup": "codex-brain" },
  "storage": {
    "flueDatabasePath": ".gorombo/db/flue.sqlite",
    "sessionDatabasePath": ".gorombo/db/sessions.sqlite"
  },
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

`storage` selects the Flue persistence and session SQLite paths. `memory` configures the structured-memory engine (see [Memory Helper](#memory-helper-structured-memory)). Any `memory` field can be overridden by a `GOROMBO_MEMORY_*` environment variable (`GOROMBO_MEMORY_BACKEND`, `GOROMBO_MEMORY_SQLITE_PATH`, `GOROMBO_MEMORY_RETENTION_DAYS`, `GOROMBO_MEMORY_ARCHIVE_DELETE_DAYS`, `GOROMBO_MEMORY_MAX_CHECKLIST_DEPTH`, `GOROMBO_MEMORY_DEFAULT_LIMIT`, `GOROMBO_MEMORY_MAX_CONTEXT_TOKENS`); env wins over JSON.

Change model choices in the shipped runtime JSON file, then restart the runtime/gateway. Keep API keys and service credentials in `.env` or the deployment secret manager.

For Node distribution, `.env` lives beside `package.json` at the runtime root. `pnpm start` runs:

```sh
node --env-file=.env .gorombo/sim-one-alpha/server.mjs
```

This loads provider keys, `API_SECRET`, and service settings before the built server starts.

Expected future environment values may include:

```text
OPENAI_API_KEY
ANTHROPIC_API_KEY
OLLAMA_API_KEY
OLLAMA_CLOUD_API_KEY
OLLAMA_CLOUD_BASE_URL
OLLAMA_LOCAL_BASE_URL
OLLAMA_LOCAL_API_KEY
CODEX_BRAIN_LOCAL_API_URL
CODEX_BRAIN_LOCAL_API_KEY
TELEGRAM_BOT_TOKEN
API_SECRET
TAVILY_API_KEY
BRAVE_SEARCH_API_KEY
```

`GOROMBO_MODEL`, `GOROMBO_MODEL_BACKUP`, and `GOROMBO_CONFIG_PATH` are not supported. Model choices must be card keys in the shipped `gorombo.config.json` runtime file.

Do not commit real secrets.

Use local `.env` files or the deployment platform's secret manager.

## Status

### Built

- Flue-based orchestrator agent with protocol loading, memory retrieval, RAG, and tool delegation
- Researcher subagent with web research (Ollama Search), query planning, cache, and evidence packing
- Coding worker with 5 subagents (triage, implementer, test-debug, code-review, github) and approval-gated repo mutations
- Structured memory engine (Rust/WASM) with checklists, todos, session notes, SQLite durability
- RAG architecture with memory retrieval, web search, LanceDB vector store, embedding fallback chain
- SQLite-backed protocol system with runtime rule loading
- Capability registry (SQLite) for runtime-extensible skills, tools, workers, and MCP servers
- Telegram connector, Web/API connector, scheduled jobs (Croner)
- Product `sim-one` wrapper with Ratatui TUI launch and capability subcommands
- Ratatui terminal UI with transcript scrolling, prompt editing, live status/spinner, stream rows, and durable session commands
- Model card system with provider registration, context budget, and compaction
- Image generation tools (Runpod Public Endpoints)
- Built-in MCP (Astro docs search)
- Session budget and compaction system

### Roadmap

- Installed `sim-one` PATH packaging and service-management commands
- Install script (`sim-one.sh`) and first-run wizard TUI
- Web UI (browser dashboard + chat via `@flue/react` + `react-dom`)
- Writing worker
- Testing / Review worker
- Discord and future connectors
- Document-index provider (currently a placeholder, not wired into the RAG router)
- Gateway service management (systemd/pm2 lifecycle)

## Memory Helper (Structured Memory)

The Memory Helper is the agent's durable memory: **checklists, todos, and session notes** that survive across long-running tasks and process restarts. It is built as a Rust crate compiled to WebAssembly, with SQLite as the durable backing store.

### How it works

```text
model tools (orchestrator / coding-worker)
  -> TypeScript shim  (src/engine/memory/rust-memory-engine.ts)
  -> Rust engine       (crates/gorombo-memory/ -> WASM via wasm-pack)
       - data model: Checklist / ChecklistItem / Todo / SessionNote
       - scope matching + tag/keyword scoring + cycle/depth validation
  -> PersistingMemoryEngine decorator
       - every create/update/delete is written to SQLite
       - on cold start the WASM index is hydrated from SQLite via reconcile_index
  -> retrieve_memory (structured-memory provider) -> context budget -> model
```

- **Engine:** the data model, scope matching, and query scoring live in Rust (`crates/gorombo-memory/`), compiled to WASM with `wasm-pack`. A thin TypeScript shim (`src/engine/memory/rust-memory-engine.ts`) loads the WASM module and delegates every mutation and query to it. A pure-TypeScript `InMemoryMemoryEngine` mirrors the same contract as a parity reference for unit tests.
- **Durable store:** a `PersistingMemoryEngine` decorator wraps the engine so every create/update/delete is persisted to SQLite (default `.gorombo/db/structured-memory.sqlite`). The WASM in-memory index is hydrated from the durable store on cold start via `reconcile_index`, so records survive process restarts.
- **Data model:**
  - **Checklist** — a scoped list with nested `ChecklistItem`s (parentId tree, ordinal ordering, status, tags, due dates).
  - **Todo** — a scoped task with priority, status, due date, tags.
  - **SessionNote** — a pinned decision/reminder with importance and optional LanceDB semantic search.
- **Scope is truth, never from the model.** Scope derivation differs by tool family:
  - **Orchestrator tools** (`create_checklist`, `create_todo`, `store_session_note`, and their update/list counterparts) derive all scope fields (`actorId`/`conversationId`/`projectId`/`threadId`) from a trusted persisted `NormalizedMessageEvent` (`eventId`); the model cannot supply scope, and update operations verify the target record's scope matches the trusted event scope before mutating.
  - **Coding-worker tools** (`coding_task_*`) inject `projectId` from the trusted worker context (`CodingWorkspaceTargetInput` — `projectId`/`projectSlug`/`projectRelativePath`/`repoPath`), not from a chat event; `taskId` is the trust anchor. They fail closed at execution time if no trusted project scope is available.
- **Retrieval** is surfaced through `retrieve_memory` (default providers include `structured-memory`) alongside session memory, ranked and truncated to the context budget. Session notes are optionally searchable by LanceDB semantic similarity (merged with the keyword index via reciprocal rank fusion), with a graceful keyword-only fallback when no embedding client is configured.
- **Coding worker** tools (`coding_task_*`) route every mutating write through `SharedCodingApprovalService` as an audit-only `memory.write` event (never blocking). The `coding_task_handoff_plan_to_checklist` tool copies a finished task run's plan into a durable checklist for cross-run continuity.

### Build and smoke

Build the WASM artifact and run the Memory Helper smoke:

```sh
pnpm run wasm:build
pnpm run smoke:memory
```

`pnpm run wasm:build` rebuilds the Rust crate to WASM and requires the Rust toolchain + `wasm-pack`. This is only needed when modifying the structured-memory engine; the shipped `.gorombo/sim-one-alpha/memory/` artifact is already compiled and runs without Rust.

The default smoke drives the real Memory Helper tools, WASM engine, SQLite, `retrieve_memory`, and the coding-worker path end-to-end with a durability restart check (no live model required). To run the real-model smoke that boots the server and lets a live model drive the orchestrator memory tools, set `GOROMBO_SMOKE_REAL_MODEL=1` (requires a `.env` with model API creds and a built `.gorombo/sim-one-alpha/`): `GOROMBO_SMOKE_REAL_MODEL=1 pnpm run smoke:memory`.

### Configuration

The `memory` block of `gorombo.config.json` configures the engine:

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

Any field can be overridden by a `GOROMBO_MEMORY_*` environment variable (`GOROMBO_MEMORY_BACKEND`, `GOROMBO_MEMORY_SQLITE_PATH`, `GOROMBO_MEMORY_RETENTION_DAYS`, `GOROMBO_MEMORY_ARCHIVE_DELETE_DAYS`, `GOROMBO_MEMORY_MAX_CHECKLIST_DEPTH`, `GOROMBO_MEMORY_DEFAULT_LIMIT`, `GOROMBO_MEMORY_MAX_CONTEXT_TOKENS`); env wins over JSON.


## Testing

Run relevant verification before calling work complete.

**Required one-time setup:** download the bundled local embedding model before running tests. It is gitignored (90MB, not committed) and the embedding/RAG unit tests cannot pass without it:

```sh
pnpm fetch-embedding-model
```

This populates `assets/models/embeddings/all-MiniLM-L6-v2/`. The cloud embedding provider is expected to return 401/403 until a valid cloud embedding key is configured; the bundled `all-MiniLM-L6-v2` ONNX model is the working fallback by design, so it must be present for the fallback-chain tests to pass.

Common commands:

```sh
pnpm test
pnpm run typecheck
pnpm run build
pnpm run build:tui:ratatui # build the Rust/Ratatui TUI binary
pnpm run build:cli      # build the product CLI wrapper and sim-one launcher
pnpm run build:all      # build runtime + Ratatui TUI + CLI and check sim-one
pnpm run test:unit      # unit tests only
pnpm run test:http      # HTTP integration test against built server
pnpm run test:tui        # TUI end-to-end test (requires OLLAMA_API_KEY)
pnpm run test:tui:ratatui # packaged Ratatui product smoke (requires OLLAMA_API_KEY or OLLAMA_CLOUD_API_KEY)
pnpm run smoke:http
pnpm run wasm:build      # build the gorombo-memory WASM artifact
pnpm run cargo:test      # cargo test --workspace
pnpm run smoke:memory    # Memory Helper end-to-end + durability smoke
```

`pnpm test` runs the TypeScript unit suite, builds `.gorombo/sim-one-alpha/server.mjs`, then runs `pnpm run test:http` against the built server over real localhost HTTP. The root `.env` file remains the runtime environment source; it is not copied into the build output.

For a live built-server chat smoke through `/api/chat/events`, run:

```sh
pnpm run smoke:http -- --live-chat
```

If the project defines other scripts in `package.json`, use those exact scripts.

Do not claim tests passed unless they were actually run.

## Public Development Status

This repository is public during development to help the community learn from and contribute to the project.

The project may become private later as proprietary business logic, client-specific workflows, and production infrastructure are added.

## Contributing

Contributions are welcome during the public development phase.

Contribution guidelines are still being finalized.

Placeholder for expanded contribution guidelines:

```text
TBD: branch naming, issue labels, pull request process, coding standards, review rules, and community expectations.
```

## Code of Conduct

A project code of conduct will be added as the community grows.

Placeholder for future Code of Conduct:

```text
TBD: community standards, reporting process, and enforcement guidelines.
```

## Security

Do not open issues containing secrets, tokens, API keys, private customer data, or confidential business information.

Security policy placeholder:

```text
TBD: responsible disclosure process and security contact.
```

## License

License placeholder:

```text
TBD: license selection.
```

## Attribution

SIM-ONE Alpha is built by [Gorombo](https://gorombo.com) with [Flue](https://flueframework.com), the TypeScript agent harness framework from the Astro ecosystem.

Flue provides the underlying agent harness.

SIM-ONE Alpha adds protocol, memory, registry, connector, retrieval, worker, and business workflow layers on top of Flue.

## Guiding Principle

SIM-ONE Alpha is not built around one giant prompt.

It is built around an agent that can coordinate rules, memory, retrieval, tools, skills, workers, registries, and connectors.

```text
Protocols provide rules.

Memory provides context.

RAG provides knowledge.

Tools provide actions.

Workers provide specialized execution.

The agent coordinates the system.

```
