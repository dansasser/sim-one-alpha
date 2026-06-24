# Product Flow — SIM-ONE Alpha

This document defines the end-to-end product flow for SIM-ONE Alpha. It is the authoritative reference for how the product is installed, configured, launched, and used. All documentation, CLI design, and code must align with this flow.

## Product Identity

- **Product name:** SIM-ONE Alpha (the `sim-one` binary)
- **Company:** Gorombo
- **Framework:** Flue (TypeScript agent harness from the Astro team)
- **Repository:** `sim-one-alpha`

## Install Flow

### 1. Package install (`sim-one.sh`)

The user installs SIM-ONE Alpha via a shell script (`sim-one.sh`). This script:

- Installs the runtime artifact (`.gorombo/sim-one-alpha/` — the built Flue Node server)
- Installs the two TUI interfaces (wizard + coding interface)
- Installs the `sim-one` binary on the user's PATH
- Installs to `~/.gorombo/` (runtime data, SQLite, capabilities, config)

This is a product install, not a developer setup. The user does not need Node, pnpm, or Rust installed — the package bundles everything needed to run.

### 2. First run — the wizard TUI

The first thing `sim-one.sh` does after install is launch the **wizard TUI**. The wizard walks the user through initial setup:

- **Model selection** — choose primary and backup model cards
- **API keys** — enter provider secrets (Ollama, OpenAI, Anthropic, Runpod, etc.)
- **Channel setup** — optional: Telegram bot token, Discord token, etc.
- **Capability setup** — optional: add initial skills, tools, MCP servers, workers
- **Persona/workspace** — configure the agent's persona and workspace files
- **Service launch** — start the gateway as an always-on background process

The wizard writes:
- `.env` — secrets
- `~/.gorombo/gorombo.config.json` — runtime config (models, storage, memory, capabilities)
- `~/.gorombo/db/` — SQLite databases (protocols, capabilities, sessions, structured memory)
- `~/.gorombo/capabilities/` — materialized skill/tool/worker directories

### 3. The gateway — always-on service

After the wizard completes, the `.gorombo/sim-one-alpha/server.mjs` Node process is running as a persistent background service (systemd, pm2, or equivalent). This is the **gateway** — the always-on agent runtime, equivalent to OpenClaw's gateway.

The gateway:
- Runs the Flue agent runtime (orchestrator, workers, tools, skills, protocols, memory, RAG)
- Listens for incoming messages from connectors (Telegram, Discord, Web API, scheduled jobs)
- Hosts the HTTP API for external clients (web UI, TUI, admin endpoints)
- Loads user-defined capabilities from SQLite + `~/.gorombo/capabilities/` at startup
- Survives restarts — durable sessions, SQLite persistence, capability store

### 4. Interfaces to the gateway

The user interacts with the gateway through multiple interfaces:

#### Connectors (external, always-on)
- **Telegram** — bot receives messages, dispatches to orchestrator, sends replies
- **Discord** — (future) same pattern
- **Web API** — HTTP endpoints for external integrations
- **Scheduled jobs** — cron-style triggers that dispatch to the orchestrator

#### Web UI (external, browser)
- **User dashboard** — manage capabilities, view sessions, configure settings
- **Web chat** — chat with the agent in a browser
- Built with `@flue/react` + `react-dom` + `@flue/sdk`

#### TUI coding interface (local terminal)
- Launched with the product name: `sim-one` (no arguments)
- Equivalent to how users launch `opencode`, `claude`, or `codex`
- Connects to the running gateway over HTTP via `@flue/sdk`
- Built with Ink (React for terminals) + `@flue/react` + `@flue/sdk`
- Shows: live agent conversation, tool calls, subagent delegations, approval prompts, status

## The `sim-one` CLI

The `sim-one` binary is the unified product command. It lives on the user's PATH after install.

### Launch the TUI coding interface
```sh
sim-one
```
Launches the interactive TUI connected to the running gateway. This is the primary day-to-day interface for terminal users.

### Install / first run
```sh
sim-one install
```
Launches the wizard TUI for initial setup. This is also what `sim-one.sh` triggers on first install.

### Capability management
```sh
# Add capabilities
sim-one skill add <github-url|local-path> <id> <name> [description] [--enable]
sim-one tool add <github-url|local-path> <id> <name> [description]
sim-one worker add <github-url|local-path> <id> <name> [description]
sim-one mcp add <id> <name> --url <url> [--transport <streamable-http|sse>] [--token-env <ENV>] [--enable]

# List capabilities
sim-one skill list
sim-one tool list
sim-one mcp list
sim-one worker list

# Enable/disable (for tools/workers/MCP that require approval)
sim-one skill enable <id>
sim-one tool disable <id>

# Update (re-fetch from source)
sim-one skill update <id>

# Remove
sim-one skill remove <id>
sim-one tool remove <id>
```

### Configuration and diagnostics
```sh
sim-one doctor          # Check install health, connectivity, model config
sim-one config set <key> <value>  # Set runtime config values
sim-one config get <key>          # Read runtime config values
sim-one status         # Check if the gateway service is running
sim-one restart        # Restart the gateway service
sim-one stop           # Stop the gateway service
```

### NOT the product interface (developer-only)
- `pnpm capabilities:add skill ...` — developer pnpm script, not the product CLI
- `pnpm run build:prod` — developer build+test workflow, not the product install
- `node scripts/capability-admin.mjs ...` — standalone dev-time admin script, replaced by `sim-one` subcommands
- `pnpm --filter sim-one-alpha-tui-proto exec tsx src/cli.tsx` — prototype TUI launch, replaced by `sim-one`

## Package structure (target)

```
sim-one-alpha/                    # repository (development)
  src/                            # runtime source (compiled to .gorombo/sim-one-alpha/)
  tui-proto/                      # throwaway TUI prototype (deleted when production TUI ships)
  scripts/                        # dev-time scripts (capability-admin.mjs, build-prod.mjs, etc.)
  .gorombo/sim-one-alpha/                           # built runtime artifact (what gets installed)

# Install package (what sim-one.sh installs):
  sim-one                         # the unified binary (wizard + TUI + admin subcommands)
  .gorombo/sim-one-alpha/                           # the runtime gateway
  ~/.gorombo/                     # runtime data (SQLite, capabilities, config, .env)
```

The `sim-one` binary is the production TUI package from the agent-tui plan (`sim-one-alpha-tui`). It contains:
- The wizard TUI (Ink + React)
- The coding interface TUI (Ink + React + `@flue/react` + `@flue/sdk`)
- Admin subcommands (skill/tool/worker/mcp management, config, doctor, status)
- Service management (start/stop/restart the gateway)

## Current state vs target

| Component | Current state | Target |
| --- | --- | --- |
| Runtime gateway (`.gorombo/sim-one-alpha/server.mjs`) | ✅ Working — Flue agent, HTTP API, connectors | Production-ready |
| Capability store + merge layer | ✅ Working — SQLite, CLI, agent tools, MCP broker | Wired into `sim-one` subcommands |
| Wizard TUI | ❌ Not built | `sim-one install` launches wizard |
| Coding interface TUI | ✅ Prototype (`tui-proto/`) | Production `sim-one` (no args) |
| `sim-one` binary | ❌ Not built | Unified CLI with all subcommands |
| Web UI | ❌ Not built | `@flue/react` + `react-dom` dashboard + chat |
| Install script (`sim-one.sh`) | ❌ Not built | Package install + wizard trigger |
| `capability-admin.mjs` | ✅ Working (dev-time) | Replaced by `sim-one skill/tool/worker/mcp` subcommands |
| `build:prod` launcher | ✅ Working (dev-time) | Replaced by `sim-one` service management |

## Key principles

1. **The product is `.gorombo/sim-one-alpha/` + the `sim-one` binary.** Users don't need pnpm, Node, or Rust. They install via `sim-one.sh` and use `sim-one`.
2. **The gateway is always on.** After install, `.gorombo/sim-one-alpha/server.mjs` runs as a background service. Connectors (Telegram, etc.) and interfaces (TUI, Web UI) connect to it.
3. **The `sim-one` binary is the only command.** It launches the TUI, runs the wizard, manages capabilities, manages config, and manages the service. No `pnpm` commands in the product interface.
4. **Capabilities are runtime-extensible.** Users add skills/tools/workers/MCP via `sim-one` subcommands. A service restart picks them up. No rebuild needed.
5. **The TUI is React via Ink.** The Web UI is React via `react-dom`. Both use `@flue/react` hooks. Shared logic lives in a shared package; presentation is authored per target.
6. **`~/.gorombo/` is the runtime data root.** SQLite, capabilities, config, .env all live here. It survives `.gorombo/sim-one-alpha/` upgrades.
7. **Local auth is loopback-based, not token-based.** The TUI connects to the server over `127.0.0.1` with no secret. The server middleware bypasses auth for loopback origins. External connectors (Telegram, web, Discord) require `API_SECRET` via `x-api-secret` header. The wizard never generates a SIM-ONE-internal secret.