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

Submitted user prompts render as full-width gray bands, including wrapped and explicit-newline continuation rows. Recognized transcript labels include the colon and use bold semantic accents: `assistant:` cyan, `operation:` yellow, `tool:` blue, `task:` magenta, `turn:` green, `system:` and `preflight:` light green, `log:` dark gray, and `error:` light red. Only the label is accented; assistant and activity bodies retain the normal terminal foreground. Root-agent assistant text is dimmed while `text_delta` events are still arriving, then returns to normal intensity when the authoritative final arrives. Thinking labels are bold gray italic, and thinking bodies remain lower-contrast gray italic. Terminals without italic or dim support still retain their color and label distinctions.

Assistant responses render Markdown while preserving the original Markdown in canonical session text. Supported terminal presentation includes bold, italic, inline and fenced code, headings, lists, blockquotes, and links. Inline code uses the prompt-editor background, links are underlined, and headings are bold. The `assistant:` label is outside the Markdown body and keeps its semantic color. While a response is streaming, Markdown modifiers remain intact and the entire live body is additionally dimmed; final reconciliation removes only the live dimming. Markdown-aware wrapping still moves complete words based on terminal display columns.

All transcript text uses a two-column left margin inside the pane border. The margin is deducted from the available wrap width so text wraps before the right edge; on extremely narrow terminals it contracts to preserve at least one content column. Word-wrapped and explicit multiline continuation rows keep the same margin and their semantic body style without repeating or extending the label accent. Submitted `you:` rows remain full-width gray bands, including the margin cells, instead of receiving a separate prefix color.

The initial transcript should contain startup/preflight rows, the gateway-resolved active TUI session, and the agent greeting. It should not contain scaffold scroll-test rows or a default `primary` session; specific old sessions are shown only after an explicit `--session` launch or `/resume`.

The bottom pane contains gateway/session/model status and the editable prompt line. The entire visible prompt-editor interior uses a darker gray background so the active composer remains distinct from transcript content. Prompt editing remains active while the transcript is scrolled.

## Prompt Editing

Press `Enter` to submit the prompt. To insert a newline, type an unescaped `\` at the cursor and press `Enter`; the TUI removes that trailing backslash and starts the next prompt line without submitting. A doubled trailing backslash remains literal. Enter key-repeat events are ignored so one physical Enter produces one submit or newline action. `Shift+Enter` remains available on terminals that report it distinctly.

The editor wraps long input before the word that no longer fits, grows to five visible rows, and then scrolls its own contents while keeping the cursor visible. Words are never split across rows. Wrapping, row padding, and cursor placement use terminal display columns, so emoji, CJK characters, and combining marks do not corrupt row boundaries. Transcript tail-following is recalculated as the editor grows, so the latest response remains directly above the prompt. While a prompt is pending, a duplicate submit is shown as a visible status instead of queueing a second prompt.

Supported editing keys include:

```text
Left / Right
Up / Down (wrapped or explicit prompt rows)
Ctrl+Left / Ctrl+Right
Home / End
Ctrl+A / Ctrl+E
Ctrl+U
Backspace / Delete
Esc
Ctrl+C
```

## Scrolling

Use `PgUp`, `PgDown`, or the mouse wheel to scroll the transcript while the prompt remains focused. `Up` and `Down` move through wrapped or explicit prompt rows whenever prompt text is present, preserving the intended terminal display column across shorter rows. With an empty prompt they retain transcript line scrolling. Scrolling away from the tail does not block typing. New activity does not snap the viewport back to the bottom until tail-following is restored.

Transcript lines use the same word-boundary wrapping as the prompt. When the next word does not fit, the complete word moves to the next row; the renderer does not split it at the pane edge.

While live-tail following is active, every rendered frame anchors the viewport to the actual last wrapped transcript row. Final responses, retries, activity updates, and prompt-height changes therefore keep the newest line visible. Manual scrollback disables that anchoring until the user returns to the tail. The border remains the session title; the status row adds `view: scrolled back` only while manual scrollback is active.

Only root-orchestrator assistant output becomes a chat response. Nested worker/subagent `text_delta` and `message_end` payloads remain internal to the parent agent; task and tool activity can still be represented by their structured activity rows. Root-agent `text_delta` events replace the pending spinner with one dimmed `assistant:` block and update that block in place.

The final assistant message is rendered as soon as Flue emits its authoritative root `message_end` event. It replaces the complete live block, including every multiline continuation, and removes dimming. The still-running HTTP prompt request then reconciles command/session metadata, errors, and response text over that same complete range instead of creating a duplicate response or leaving orphaned continuation lines. Tool, turn, and operation rows that arrive afterward remain above the final response.

Live tail includes one blank visual margin row after the final transcript content. This row is a rendering sentinel only: it is not persisted in the session, included in agent context, or added to transcript history. The newest response should always appear directly above it.

## Status Bar

The transcript border shows `SIM-ONE Alpha - <session-id>` for an unnamed resolved session and `SIM-ONE Alpha - <name>` for an explicitly named session. Before startup resolves a session it shows only `SIM-ONE Alpha`. Explicit names survive `/resume` and startup restoration because they are stored separately from automatic prompt-derived conversation titles. `/session` and `/exit` retain access to the durable id.

The status area shows the gateway connection, stream state, pending response state, elapsed thinking time, and a spinner while the agent is working. Live-tail following is implicit. When the user scrolls away from the tail, the status begins with `view: scrolled back` until tail-following is restored.

During startup, status and transcript rows show gateway readiness, active TUI session resolution, stream attach, and the greeting turn. After preflight completes, normal prompt entry is available.

If a live stream disconnects, the status changes to reconnecting or failed. Prompt submission still uses the gateway request path and reports errors into the transcript.

## Slash Commands

Typing `/` as the first prompt character opens a command palette above the status line without resizing the prompt or transcript. Continue typing to filter by command name. `Up` and `Down` move the highlight and scroll the six-row palette while it is open; `Enter` or `Tab` inserts the highlighted command without executing it. Press `Enter` again after supplying any arguments. `Esc` dismisses the palette first and exits the TUI only when the palette is closed. A complete command typed directly still submits normally.

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

On POSIX systems, this smoke launches the packaged `sim-one` command in a real PTY and verifies slash-Enter multiline input against a local gateway stub. It also sends nested worker output, a root live assistant delta, and a multiline Markdown root `message_end` while holding the HTTP prompt response open. The smoke verifies worker payloads remain internal, Markdown source markers are replaced by terminal styles, and the packaged TUI renders the root live/final answer before HTTP settles. Cross-platform Rust integration tests exercise exact multiline consolidation, Markdown styles, input, app-state, ordering, terminal-size, and framebuffer behavior.

If the TUI exits after `/exit`, use the printed session id to resume:

```text
Exited SIM-ONE Alpha TUI. Session: <session-id>
```

Then launch again and run:

```text
/resume <session-id>
```
