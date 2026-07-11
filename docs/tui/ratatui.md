# Ratatui TUI

The Ratatui TUI is the production local terminal surface for SIM-ONE Alpha. It is a connector client: prompts and backend-owned slash commands go through the local gateway, and orchestration stays inside the Flue agent runtime.

Implementation details live in `docs/architecture/tui-cli-session-flow.md`. Packaged runtime operations live in `docs/operations/product-tui.md`.

## Launch

Build the product first when the `.gorombo/` artifacts are missing or stale:

```sh
source "$NVM_DIR/nvm.sh"
nvm use 22
pnpm run build:all
```

Launch the packaged product command:

```sh
cd /opt/ai/sim-one-alpha-tui-production
./.gorombo/sim-one-cli/sim-one
```

The command reuses a healthy local gateway when one is already running. If it cannot find one, it starts the packaged `.gorombo/sim-one-alpha/server.mjs` runtime and connects the TUI to it.

On a normal no-argument launch, the TUI starts clean without a default `primary` session. It asks the gateway for the active durable TUI session for the local TUI connector scope, attaches the live stream to that returned `tui-*` session, shows preflight rows, then sends an automatic startup greeting prompt to the main orchestrator. The greeting uses the built-in Flue `greeting-preflight` skill and the loaded workspace identity/user context.

Useful launch flags:

```sh
./.gorombo/sim-one-cli/sim-one --session tui-2026-...
./.gorombo/sim-one-cli/sim-one --port 3940
./.gorombo/sim-one-cli/sim-one --base-url http://127.0.0.1:3940
```

Use `--session <id>` only when you intentionally want to attach to an existing session and stream its current context.

## Layout

The top pane is the transcript and context viewport. It contains user prompts, assistant responses, stream activity rows, and local system notices.

The initial transcript should contain startup/preflight rows, the gateway-resolved active TUI session, and the agent greeting. It should not contain scaffold scroll-test rows or a default `primary` session; specific old sessions are shown only after an explicit `--session` launch or `/resume`.

The bottom pane contains gateway/session/model status and the editable prompt line. Prompt editing remains active while the transcript is scrolled.

## Prompt Editing

Press `Enter` to submit the prompt. To insert a newline, type `/` at the cursor and press `Enter`; the TUI removes the trailing slash and starts the next prompt line without submitting. Enter key-repeat events are ignored so one physical Enter produces one submit or newline action. Slash commands such as `/new` and `/compact` still submit normally because their final character is not `/`.

The editor wraps long input, grows to five visible rows, and then scrolls its own contents while keeping the cursor visible. Transcript tail-following is recalculated as the editor grows, so the latest response remains directly above the prompt. While a prompt is pending, a duplicate submit is shown as a visible status instead of queueing a second prompt.

Supported editing keys include:

```text
Left / Right
Ctrl+Left / Ctrl+Right
Home / End
Ctrl+A / Ctrl+E
Ctrl+U
Backspace / Delete
Esc
Ctrl+C
```

## Scrolling

Use `PgUp` and `PgDown` to scroll the transcript. Scrolling away from the tail does not block typing. New activity does not snap the viewport back to the bottom until tail-following is restored.

While the title shows `Transcript - live tail`, every rendered frame anchors the viewport to the actual last wrapped transcript row. Final responses, retries, activity updates, and prompt-height changes therefore keep the newest line visible. Manual scrollback disables that anchoring until the user returns to the tail.

The final assistant message is rendered as soon as Flue emits its authoritative `message_end` event. The still-running HTTP prompt request then reconciles command/session metadata or an error into that same transcript row instead of creating a duplicate response. Tool, turn, and operation rows that arrive afterward remain above the final response.

Live tail includes one blank visual margin row after the final transcript content. This row is a rendering sentinel only: it is not persisted in the session, included in agent context, or added to transcript history. The newest response should always appear directly above it.

## Status Bar

The status area shows the gateway connection, active session, stream state, pending response state, elapsed thinking time, and a spinner while the agent is working.

During startup, status and transcript rows show gateway readiness, active TUI session resolution, stream attach, and the greeting turn. After preflight completes, normal prompt entry is available.

If a live stream disconnects, the status changes to reconnecting or failed. Prompt submission still uses the gateway request path and reports errors into the transcript.

## Slash Commands

TUI-local commands:

```text
/session
/sessions [limit]
/help
/exit
```

Backend session commands:

```text
/new [title]
/clear [title]
/resume <session-id>
/rename <title>
/compact
```

See [session-management.md](session-management.md) for the command behavior and recovery flow.

## Troubleshooting

If the command cannot find the TUI binary, rebuild:

```sh
source "$NVM_DIR/nvm.sh"
nvm use 22
pnpm run build:all
```

If the gateway fails to start, run the product smoke:

```sh
pnpm run test:tui:ratatui
```

On POSIX systems, this smoke launches the packaged `sim-one` command in a real PTY and verifies slash-Enter multiline input against a local gateway stub. It also holds the HTTP prompt response open after sending a final Flue `message_end` event and verifies that the packaged TUI already rendered the answer. Cross-platform Rust integration tests exercise the same input, app-state, ordering, terminal-size, and framebuffer behavior.

If the TUI exits after `/exit`, use the printed session id to resume:

```text
Exited SIM-ONE Alpha TUI. Session: <session-id>
```

Then launch again and run:

```text
/resume <session-id>
```
