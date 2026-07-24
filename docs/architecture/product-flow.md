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
- Connects to the gateway over loopback HTTP as connector `tui`
- Built as a Rust/Ratatui terminal client launched by the TypeScript `sim-one` product wrapper
- Shows: transcript/context, prompt editor, gateway/session/model status, stream activity, thinking spinner, tool/status rows, and session command results
- Owns terminal interaction only. The Flue gateway owns orchestration, model calls, tools, workers, protocols, memory, and compaction.

## The `sim-one` CLI

The `sim-one` binary is the unified product command. It lives on the user's PATH after install.

### Launch the TUI coding interface
```sh
sim-one
```
Launches the interactive TUI connected to the running gateway. This is the primary day-to-day interface for terminal users.

### Planned install / first run

```sh
sim-one install
```

This is the target first-run wizard command and is not present in the current built CLI. The planned `sim-one.sh` installer will invoke it once that product-install phase ships.

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

### Planned configuration, diagnostics, and service management

```sh
sim-one doctor          # Check install health, connectivity, model config
sim-one config set <key> <value>  # Set runtime config values
sim-one config get <key>          # Read runtime config values
sim-one status         # Check if the gateway service is running
sim-one restart        # Restart the gateway service
sim-one stop           # Stop the gateway service
```

These commands describe the target installed product. The current built CLI does not register them yet.

### NOT the product interface (developer-only)
- `pnpm capabilities:add skill ...` — developer pnpm script, not the product CLI
- `pnpm run build:all` — developer build workflow (builds runtime + Ratatui TUI + CLI and checks the product command), not the product install
- `node scripts/capability-admin.mjs ...` — standalone dev-time admin script, replaced by `sim-one` subcommands
- `.gorombo/sim-one-ratatui/sim-one-ratatui-tui` — lower-level TUI binary used by the wrapper and tests, not the primary user command

## Package structure (target)

```text
sim-one-alpha/                    # repository (development)
  src/                            # runtime source (compiled to .gorombo/sim-one-alpha/)
  sim-one-cli/                    # product command wrapper and capability subcommands
  tui/ratatui/                    # Rust/Ratatui terminal client
  scripts/                        # dev-time scripts (capability-admin.mjs, copy-runtime-config.mjs, etc.)
  .gorombo/sim-one-alpha/                           # built runtime artifact (what gets installed)

# Install package (what sim-one.sh installs):
  sim-one                         # the unified binary (wizard + TUI + admin subcommands)
  .gorombo/sim-one-alpha/                           # the runtime gateway
  ~/.gorombo/                     # runtime data (SQLite, capabilities, config, .env)
```

The built development product command currently contains:
- The `sim-one` wrapper under `.gorombo/sim-one-cli/`
- No-argument launch of the packaged Ratatui coding interface
- Capability subcommands (`skill`, `tool`, `worker`, `mcp`)
- Legacy Ink fallback behind `--ink`

The first-run wizard, `sim-one.sh`, service manager commands, `doctor`, and config commands remain planned product-install work and are not accepted by the current CLI.

## Current state vs target

| Component | Current state | Target |
| --- | --- | --- |
| Runtime gateway (`.gorombo/sim-one-alpha/server.mjs`) | ✅ Working — Flue agent, HTTP API, connectors | Production-ready |
| Capability store + merge layer | ✅ Working — SQLite, CLI, agent tools, MCP broker | Wired into `sim-one` subcommands |
| Wizard TUI | ❌ Not built | `sim-one install` launches wizard |
| Coding interface TUI | ✅ Ratatui product path (`tui/ratatui/`) | Continue hardening approvals and progress detail |
| `sim-one` binary | ✅ Built in repo output (`.gorombo/sim-one-cli/sim-one`) | Installable unified PATH command |
| Web UI | ❌ Not built | `@flue/react` + `react-dom` dashboard + chat |
| Install script (`sim-one.sh`) | ❌ Not built | Package install + wizard trigger |
| `capability-admin.mjs` | ✅ Working (dev-time) | Product users use `sim-one skill/tool/worker/mcp` subcommands |
| `build:all` product build | ✅ Working (dev-time) | Replaced by installer/package build |

## Key principles

1. **The product is `.gorombo/sim-one-alpha/` + the `sim-one` binary.** Users don't need pnpm, Node, or Rust. They install via `sim-one.sh` and use `sim-one`.
2. **The gateway is always on.** After install, `.gorombo/sim-one-alpha/server.mjs` runs as a background service. Connectors (Telegram, etc.) and interfaces (TUI, Web UI) connect to it.
3. **The `sim-one` binary is the only user command.** It launches the TUI and manages capabilities now. The wizard, config, doctor, and service-management subcommands are planned install work. No `pnpm` commands in the product interface.
4. **Capabilities are runtime-extensible.** Users add skills/tools/workers/MCP via `sim-one` subcommands. A service restart picks them up. No rebuild needed.
5. **The local coding TUI is Ratatui.** The TypeScript CLI wrapper routes to the Rust terminal client. The Web UI can still use React via `react-dom`; presentation is authored per target.
6. **`~/.gorombo/` is the runtime data root.** SQLite, capabilities, config, .env all live here. It survives `.gorombo/sim-one-alpha/` upgrades.
7. **Local auth is loopback-based, not token-based.** The TUI connects to the server over `127.0.0.1` with no secret. The server middleware bypasses auth for loopback origins. External connectors (Telegram, web, Discord) require `API_SECRET` via `x-api-secret` header. The wizard never generates a SIM-ONE-internal secret.

See `docs/architecture/tui-cli-session-flow.md` for the implemented `sim-one` + Ratatui + session command flow.
