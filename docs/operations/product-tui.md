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
source "$NVM_DIR/nvm.sh"
nvm use 22
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

Normal no-argument launch starts without an agent session id. The TUI asks the gateway to resolve the active durable TUI session for the local `tui` connector scope, switches to the returned `tui-*` session, then attaches the live stream. There is no default `primary` TUI session. Passing `--session <id>` is an explicit existing-session attach. TUI session commands can then clear, create, resume, or switch durable sessions inside the running app.

## Startup Preflight

After the gateway is healthy, the TUI startup flow:

```text
resolves the active durable TUI session through the gateway
attaches the stream to that active session
renders preflight rows in the transcript
sends a startup greeting prompt to the orchestrator
uses the built-in Flue greeting-preflight skill for the greeting behavior
```

The startup greeting words are produced by the main orchestrator using workspace identity/user context. The Rust TUI sends the preflight report and skill instruction; it does not hardcode the greeting.

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
startup preflight through the Ratatui product path
clean startup transcript without scaffold rows
agent greeting through the built-in greeting-preflight skill path
packaged interactive PTY input through the sim-one wrapper
slash-command palette display and keyboard selection
slash-command palette wheel navigation, mouse selection, and outside dismissal
backslash-Enter newline preservation when the terminal reports an Enter repeat
vertical arrow editing across packaged multiline prompt rows
prompt mouse cursor placement and exact submitted payload
prompt drag selection, OSC52 copy, replacement, and exact submitted payload
prompt-local mouse-wheel scrolling after the editor reaches five visible rows
transcript scrollbar track clicks from startup rows back to live tail
exact multiline prompt payload submitted to the gateway
renamed session name in final TUI status and stable session id on exit
fresh, renamed, and resumed transcript header values without status-bar changes
temporary session-database isolation for product smoke data
/new
/session
/compact
/resume
/rename
/exit
```

The Rust input/app/framebuffer suites run alongside product verification and cover cut/delete state, selection-aware `Ctrl+C`, reverse selection, UTF-8 boundaries, logical transcript copy, highlight rendering, scrollbar dragging, and pane hit-testing on every supported platform.

The TUI enables Crossterm mouse capture after Ratatui terminal initialization and disables it during normal restoration and the panic hook. App-owned selection is intentional: transcript and prompt drags remain available while wheel, scrollbar, and command-palette mouse controls are active. Completed selections are sent to the host clipboard with OSC52; terminal multiplexers may require clipboard passthrough configuration.

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
