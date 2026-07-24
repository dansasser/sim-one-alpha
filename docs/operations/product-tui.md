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

Normal no-argument launch starts without an agent session id. The TUI creates a fresh durable session through `POST /api/chat/sessions`, stores the returned `tui-*` id, then attaches its live stream. There is no default `primary` session and no implicit last-TUI-session reuse. Passing `--session <selector>` validates and resumes an exact owned id or explicit name before stream attachment. A missing selector creates a fresh session and greeting; forbidden or ambiguous selectors fail startup. TUI session commands can then clear, create, resume, or switch durable sessions inside the running app.

## Startup Preflight

After the gateway is healthy, the TUI startup flow:

```text
creates a fresh durable TUI session through the gateway lifecycle API
attaches the stream to the returned session id
renders preflight rows in the transcript
sends a startup greeting prompt to the orchestrator
uses the built-in Flue greeting-preflight skill for the greeting behavior
```

The startup greeting words are produced by the main orchestrator using workspace identity/user context. The Rust TUI sends the preflight report and skill instruction; it does not hardcode the greeting.

For `sim-one --session <selector>`, startup instead calls `POST /api/chat/sessions/:selector/resume`, verifies the stable local TUI ownership scope, resolves an exact explicit name to its canonical id when needed, restores title metadata, and attaches history without sending a greeting. If the selector is not found, the same endpoint returns a newly created session and startup follows the normal fresh greeting path.

The resume path loads the newest gateway transcript snapshot before enabling prompt input. It restores prior visible user prompts, settled public operation/thinking/tool/task rows, final root-assistant Markdown, the canonical id, and any explicit name. Internal startup instructions, raw tool results, nested worker response bodies, and TUI-local command output remain hidden. The stream attaches after the snapshot's `nextOffset`; scrolling to the first loaded exchange fetches and prepends older pages without moving the visible anchor.

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
two consecutive default launches create different durable TUI session ids
each fresh session records the greeting as its first normal event
startup records no /session, /new, or /clear lifecycle command
explicit --session validates and restores the requested named session without a greeting
resumed prompt, settled activity durations, and final Markdown appear exactly once
internal startup text, raw tool results, nested responses, and empty assistant messages stay hidden
snapshot nextOffset prevents stale catch-up from settling a new prompt
disconnect/reconnect replays one in-flight batch without duplicate activity or final output
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
newest transcript page starts at the true tail and older pages remain reachable
older-page prepend preserves the exact visible source row
prompt editing and submission remain active during transcript scrollback
transcript scrollbar track clicks from oldest restored history back to live tail
exact multiline prompt payload submitted to the gateway
renamed session name in final TUI status and stable session id on exit
fresh, renamed, and resumed transcript header values without status-bar changes
temporary session-database isolation for product smoke data
/new
/clear
/session
/sessions
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
/resume <session-id-or-name>
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

```sh
./.gorombo/sim-one-cli/sim-one --session <session-id-or-name>
```

Inside a running TUI, `/resume <session-id-or-name>` switches to another owned session. A missing in-app selector reports an error and preserves the current session.

For local support diagnostics, inspect `.gorombo/logs/sim-one-ratatui.jsonl` under the installed runtime root. The best-effort JSONL log rotates at 1 MiB with three retained files and records gateway/session/input lifecycle categories without prompt, response, selection, secret, session-name, or raw-error text. Override the path with `SIM_ONE_TUI_LOG_PATH` when isolating a test run.

For resume-history diagnosis, inspect these events in order:

```text
history.load.started
history.load.completed | history.load.failed
stream.attach.started mode=snapshot_tail
history.page.prepended (after loading an older page)
```

`history.load.completed` with zero exchanges points to missing normalized prompt/event persistence or gateway projection. A positive exchange count with no visible rows points to Ratatui document/rendering behavior. `history.load.failed` identifies a bounded transport, HTTP, parse, or session mismatch category. `hasOlder=true` without `history.page.prepended` after reaching the first exchange points to pagination trigger/cursor handling.
