# Product TUI Runtime

This guide covers the packaged SIM-ONE Alpha terminal runtime. The production command is `sim-one`; with no subcommand it opens the Ratatui TUI.

Architecture details live in `docs/architecture/tui-cli-session-flow.md`.

## Packaged Command

Build all product artifacts:

```sh
source "$NVM_DIR/nvm.sh"
nvm use 22
pnpm run build:all
```

Launch the TUI:

```sh
./.gorombo/sim-one-cli/sim-one
```

Capability subcommands remain on the same product command and do not open the TUI:

```sh
./.gorombo/sim-one-cli/sim-one skill list
./.gorombo/sim-one-cli/sim-one tool list
./.gorombo/sim-one-cli/sim-one worker list
./.gorombo/sim-one-cli/sim-one mcp list
```

## Gateway Startup And Reuse

The product command starts the Ratatui binary from `.gorombo/sim-one-ratatui/`. The Ratatui launcher checks the configured gateway base URL or port first. If the gateway is already healthy, the TUI connects and does not start another server.

If no healthy gateway is available, the launcher starts the packaged server:

```text
.gorombo/sim-one-alpha/server.mjs
```

The child server runs from the owner of the `.gorombo` runtime tree, so packaged runtime files and default data paths resolve from the product runtime root instead of the caller's arbitrary shell directory.

When the TUI exits, it only cleans up the child server it started. It does not stop a gateway that was already running.

## Runtime Paths

Build outputs:

```text
.gorombo/sim-one-cli/sim-one
.gorombo/sim-one-ratatui/sim-one-ratatui-tui
.gorombo/sim-one-alpha/server.mjs
.gorombo/sim-one-alpha/gorombo.config.json
.gorombo/sim-one-alpha/memory/gorombo_memory.js
```

Runtime data:

```text
.gorombo/db/flue.sqlite
.gorombo/db/sessions.sqlite
.gorombo/db/capabilities.sqlite
.gorombo/db/structured-memory.sqlite
```

The TUI launch defaults to session `primary` unless `--session <id>` is supplied. TUI session commands can then create or switch durable sessions inside the running app.

## Environment Files

The launcher accepts an explicit env path:

```sh
./.gorombo/sim-one-cli/sim-one --env-path /path/to/.env
```

Without `--env-path`, it uses the packaged launcher's env-file resolution. In local development, `.env` in the repository root is the normal source. In packaged runtime layouts, `.gorombo/.env` is supported as the production runtime env file.

Important provider variables for real prompt smoke tests include:

```text
OLLAMA_API_KEY
OLLAMA_CLOUD_API_KEY
CODEX_BRAIN_LOCAL_API_KEY
CODEX_BRAIN_LOCAL_API_URL
```

## Production Smoke Test

Run the same packaged path used by the product command:

```sh
source "$NVM_DIR/nvm.sh"
nvm use 22
pnpm run build:all
pnpm run test:tui:ratatui
./.gorombo/sim-one-cli/sim-one
```

The automated product smoke verifies:

```text
sim-one --help
sim-one skill list
sim-one tool list
sim-one worker list
sim-one mcp list
real prompt submission through the Ratatui product path
/new
/session
/compact
/resume
/rename
/exit
```

Manual session smoke inside the running TUI:

```text
/session
/new Manual Test
/sessions
/resume <session-id>
/rename Manual Test Renamed
/compact
/help
/exit
```

Expected final output after `/exit` restores the terminal:

```text
Exited SIM-ONE Alpha TUI. Session: <active-session-id>
```

## Troubleshooting

If the binary is missing, rebuild with `pnpm run build:all`.

If the product smoke reports a missing model key, set `OLLAMA_API_KEY` or `OLLAMA_CLOUD_API_KEY` in the environment or `.env`.

If gateway startup fails, rerun:

```sh
./.gorombo/sim-one-cli/sim-one --smoke-startup
```

If a session needs to be recovered after exit, use the printed id:

```text
/resume <session-id>
```
