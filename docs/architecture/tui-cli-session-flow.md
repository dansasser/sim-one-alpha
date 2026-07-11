# TUI, CLI, And Session Flow

This document is the repository-level map for the SIM-ONE Alpha terminal surface. It explains how the `sim-one` command, Ratatui TUI, gateway launcher, slash commands, durable sessions, and product smoke tests fit together.

User-facing command reference lives in `docs/tui/ratatui.md` and `docs/tui/session-management.md`. Operator runbook details live in `docs/operations/product-tui.md`.

The local implementation and milestone plan is `/opt/ai/plans/sim-one-ratatui-tui/plan.md`; that plan points back to these repository docs.

## Ownership

```text
sim-one-cli/
  Product command wrapper.
  Owns command routing for `sim-one`, `sim-one --help`, and capability subcommands.
  No-argument `sim-one` launches the Ratatui binary.
  `--ink` remains a legacy fallback path only.

tui/ratatui/
  Rust/Ratatui terminal client.
  Owns terminal drawing, pane-aware keyboard/mouse input mapping, transcript scroll and logical selection state, prompt editing/selection, the clickable slash-command palette, scrollbar interaction, OSC52 clipboard handoff, local TUI commands, gateway launch/reuse, stream attach/restart, and packaged binary behavior.

src/api/routes/chat-events.ts
  App-owned connector-style chat ingress.
  Owns `/api/chat/events`, `/api/chat/sessions`, trusted event persistence, session resolution, pre-LLM slash command handling, and durable prompt admission to the Flue orchestrator route.

src/engine/commands/slash-commands.ts
  Shared pre-LLM slash command parser.

src/engine/session/
  Product session catalog, access checks, Flue session persistence wrapper, compaction budget, direct-agent instance indexes, and session-memory indexing.

src/skills/greeting-preflight/SKILL.md
  Built-in Flue Agent Skill used by the main orchestrator for local startup greeting events after connector preflight.

scripts/test-ratatui-product.mjs
  Packaged product smoke for the exact built `sim-one` path.

scripts/test-ratatui-visible-final.py
  POSIX PTY regression that delivers nested worker output, a root assistant text delta, and a multiline root message_end while holding the HTTP result open. Verifies the packaged TUI keeps worker payloads internal and renders the consolidated root answer immediately.
```

The prompt editor opens a filtered command drop-up when its first token begins with `/`. The palette is capped at six visible rows and overlays the transcript above the status line, so it does not change transcript viewport height or prompt geometry. Up/Down navigate the palette while it is open, move vertically through wrapped/explicit prompt rows when prompt text is present, and retain transcript line scrolling when the prompt is empty. PgUp/PgDown always scroll transcript context. Mouse wheel events route to the palette, prompt viewport, or transcript according to the pointer location. Enter or Tab inserts the selected command; a palette click does the same. Esc or an outside click dismisses the palette before retaining normal input behavior. An unescaped trailing `\` followed by Enter inserts a prompt newline, while doubled trailing backslashes remain literal.

## Mouse And Clipboard Flow

```text
Crossterm MouseEvent
  -> input.rs preserves kind, coordinates, button, and modifiers
  -> App routes by z-order: palette -> prompt -> scrollbar -> transcript
  -> ui.rs publishes the current frame's hit regions and wrapped-row mappings
  -> App updates cursor, selection, prompt viewport, or transcript scroll state
  -> ui.rs renders selection with reversed cell styling
  -> mouse release queues logical selected text
  -> main.rs sends queued text through terminal.rs OSC52 clipboard output
```

Transcript selection stores logical source positions rather than scraping terminal cells. Normal word-wrapped rows retain source character ranges; rendered assistant Markdown rows retain equivalent plain rendered source ranges. Copy therefore omits borders, margins, scrollbar glyphs, Markdown markers, and synthetic wrap boundaries while preserving explicit logical newlines. Prompt selection stores UTF-8 byte boundaries derived from wrapped character/display-column mappings, so selection replacement, Backspace/Delete, and `Ctrl+X` cannot split a multibyte character.

Mouse capture remains enabled because wheel, drag, scrollbar, and palette behavior all depend on it. `terminal.rs` disables capture before normal Ratatui restoration and from the panic hook. OSC52 support is a host-terminal capability; clipboard failure does not change selection state or terminate the TUI.

`chat_sessions.explicit_name` stores only names explicitly supplied through `/rename`, `/new <title>`, or `/clear <title>`. It remains separate from automatic prompt-derived conversation titles. Session-management responses return that explicit name during `/session` and `/resume`, allowing Ratatui to restore `SIM-ONE Alpha - <name>` in the transcript header for a loaded named session. Fresh and unnamed sessions use `SIM-ONE Alpha`. The existing status label remains unchanged, and state synchronization never parses human-readable command response text.

The TUI is a connector surface, not an agent runtime. It must not own orchestration, protocol loading, tool selection, model execution, worker behavior, or memory/RAG decisions.

## Build Products

```text
pnpm run build
  -> .gorombo/sim-one-alpha/server.mjs
  -> .gorombo/sim-one-alpha/gorombo.config.json
  -> .gorombo/sim-one-alpha/memory/gorombo_memory.*

pnpm run build:tui:ratatui
  -> .gorombo/sim-one-ratatui/sim-one-ratatui-tui
  -> .gorombo/sim-one-ratatui/sim-one-ratatui-tui.exe on Windows

pnpm run build:cli
  -> .gorombo/sim-one-cli/cli.js
  -> .gorombo/sim-one-cli/sim-one
  -> .gorombo/sim-one-cli/sim-one.cmd on Windows

pnpm run build:all
  -> builds all of the above
  -> verifies the product command is runnable
```

The product command used from a built worktree is:

```sh
./.gorombo/sim-one-cli/sim-one
```

## Product CLI Routing

`sim-one-cli/src/cli.tsx` uses Commander for product routing:

```text
sim-one
  -> validate TUI options
  -> resolve .gorombo/sim-one-ratatui/sim-one-ratatui-tui
  -> spawn the Ratatui binary with inherited stdio

sim-one --ink
  -> launch the legacy Ink fallback path

sim-one skill|tool|worker|mcp ...
  -> run capability management commands
  -> do not launch the TUI
```

The wrapper is intentionally thin. The Rust TUI owns interactive terminal behavior and gateway lifecycle. The TypeScript CLI owns product command routing and capability subcommands.

## Gateway Startup And Runtime Root

The Ratatui launcher checks gateway health before starting anything:

```text
Ratatui binary starts
-> if --base-url is provided, use that gateway
-> otherwise resolve port from CLI/config/default
-> probe /health
-> if healthy, connect without spawning a server
-> if unhealthy, resolve packaged server.mjs
-> start Node with PORT and optional --env-file
-> wait for /health
-> enter terminal UI
```

When it starts the packaged server, the launcher sets the child process cwd to the owner of the `.gorombo` runtime tree. This keeps runtime data and packaged artifacts resolving from the product root even if the user launches the binary from another directory.

The launcher only stops a server child that it started. It does not stop a gateway that was already running.

## Startup Preflight And Greeting

A normal no-argument TUI launch does not attach to a default `primary` session. It starts with a clean local transcript and no agent session id, asks the gateway to resolve the active durable TUI session for the local `tui` connector scope, attaches the stream to that returned session, reports preflight status, then sends an automatic greeting prompt through `/api/chat/events`.

```text
TUI opens
-> render clean preflight shell
-> confirm gateway startup/reuse result
-> POST /api/chat/events text="/session" with no session field
-> gateway resolves or creates active tui-* session for connector=tui/local-tui
-> switch to returned tui-* session
-> attach live stream for the active session
-> render "preflight: all systems go"
-> POST /api/chat/events with startup report
-> orchestrator activates built-in greeting-preflight skill
-> assistant greeting renders from workspace identity/user context
```

The TUI owns only connector checks and transcript/status rendering. The greeting words are not hardcoded in Rust. The startup prompt instructs the main orchestrator to use the built-in Flue skill `greeting-preflight`, which lives at `src/skills/greeting-preflight/SKILL.md` and is registered in `src/agents/orchestrator.ts` through the documented `with { type: 'skill' }` import flow.

Passing `--session <id>` is an explicit resume-style launch. In that mode the TUI attaches to the requested session stream instead of asking the gateway to resolve the active session for the local TUI connector scope.

## Prompt Flow

Normal prompts from the Ratatui TUI use the connector-style chat path:

```text
TUI prompt submit
-> POST /api/chat/events
   connector: "tui"
   actorId: "local-tui"
   conversationId: "local-tui"
   threadId: "local-tui"
   session: <active-session-id> after startup resolution
-> persist trusted normalized event context
-> resolve product session
-> POST /agents/orchestrator/:sessionId?wait=result
-> Flue durable direct-agent submission
-> response text rendered in the transcript
```

Prompt editing is local TUI state. Enter submits normally; when the character immediately before the cursor is `/`, Enter consumes that slash and inserts a newline instead. Enter repeat events are discarded at the crossterm mapping boundary so the newline press cannot become an immediate second submit. Transcript and prompt rendering share one word-boundary row layout: a word that does not fit moves intact to the next row and is never split across rows. Prompt rows retain source character ranges while wrapping and cursor placement use Unicode terminal display columns. This keeps emoji, CJK double-width glyphs, and combining marks aligned without changing byte-safe prompt editing. The editor grows to five visible rows and then scrolls locally. Prompt-height changes recalculate the transcript viewport while preserving live-tail or scrolled-back state; they do not alter the connector session or Flue stream offset.

Before drawing, canonical transcript strings are converted into semantic rendered rows (`User`, `Assistant`, `Thinking`, tool/task/activity kinds, errors, system/preflight, and fallback rows). The transcript reserves a two-column left margin and deducts it from the row-layout width before wrapping; the margin contracts only when necessary to keep one content column on extremely narrow terminals. Wrapped rows inherit the semantic kind, streaming state, and margin of their source line, including multiline user and assistant continuations. The renderer splits a recognized first-row label, including its colon, into a bold semantic `Span`; the body remains in its normal semantic style, and continuation rows do not repeat the label accent. `theme.rs` owns the terminal palette: assistant cyan, operation yellow, tool blue, task magenta, turn green, system/preflight light green, log dark gray, and error light red. Root assistant rows add the dim modifier while live text is incomplete and remove it at finalization. User rows retain a full-width gray background across the margin, the active prompt editor receives a darker gray background, and thinking uses gray italic body text with a bold gray italic label. Italics and dimming are additive terminal metadata; color and labels remain the fallback distinctions when a terminal ignores those modifiers.

Live-tail is a render-time invariant, not a best-effort side effect of individual transcript mutations. After wrapping transcript lines for the current frame width, the renderer sets the scroll offset to the exact maximum whenever `follow_tail` is active. When the user has scrolled back, the renderer only clamps out-of-range offsets and does not snap to the tail.

Assistant response display has two coordinated inputs:

```text
Flue live stream emits root assistant text_delta
-> App replaces the pending spinner with one dimmed assistant range
-> later root text_delta events replace that complete range in place
-> nested worker/subagent text_delta and message_end remain internal
-> Flue emits authoritative root assistant message_end
-> App replaces the complete live range and removes dimming
-> later activity rows are inserted before the anchored final response
-> POST /api/chat/events settles
-> App reconciles response/session/command metadata over the same complete range
```

The TUI accepts response text only from root-orchestrator events, identified by the absence of Flue's nested `parentSession` metadata. This preserves the connector boundary: workers return results to the orchestrator, while the orchestrator returns the chat response. The synchronous HTTP result remains authoritative for request errors and session/command metadata, but response reconciliation is idempotent across the full multiline range. Pending-row indices and the response anchor are reindexed together when activity rows are inserted, preventing late operation events, pending ticks, or HTTP settlement from overwriting the first line, orphaning continuations, or duplicating the answer.

`transcript_rendered_lines()` appends one virtual blank tail-margin row after wrapping. This sentinel gives the live-tail calculation a deterministic final row and leaves visual space below the newest response. It never enters `transcript_lines`, durable session history, copied context, or Flue persistence.

The stable `local-tui` actor/conversation/thread scope is intentional. The gateway uses that connector scope to resolve the active durable TUI session, matching Telegram-style one-thread behavior. The active session id selects the durable conversation, while the stable scope lets `/new`, `/clear`, `/resume`, `/rename`, and `/compact` operate across session switches without creating unreachable conversation scopes.

## Slash Commands

Slash commands are parsed before prompt text reaches the LLM.

Backend-owned commands:

| Command | Owner | Behavior |
| --- | --- | --- |
| `/new [title]` | `src/api/routes/chat-events.ts` | Creates a new durable TUI session, returns its id, and the TUI switches to it. |
| `/clear [title]` | `src/api/routes/chat-events.ts` | Clears the connector thread by creating a new active durable session for the same TUI scope. |
| `/resume <session-id>` | `src/api/routes/chat-events.ts` | Validates session access for the TUI actor/conversation scope, returns the session, and the TUI switches to it. |
| `/rename <title>` | `src/api/routes/chat-events.ts` | Renames the active durable session. |
| `/compact` | `src/api/routes/chat-events.ts` | Opens the active durable Flue session and calls `session.compact()` without sending `/compact` to the model. |
| `/session` | `src/api/routes/chat-events.ts` | Resolves and returns the active durable session for connector-owned surfaces. |

TUI-local commands:

| Command | Owner | Behavior |
| --- | --- | --- |
| `/session` | `tui/ratatui/src/app.rs` | Prints the current resolved active session id inside the running TUI. |
| `/sessions [limit]` | `tui/ratatui/src/app.rs` + `/api/chat/sessions` | Lists recent sessions. Default limit is 10, clamped from 1 to 50. |
| `/help` | `tui/ratatui/src/app.rs` | Prints command help without reaching the gateway model path. |
| `/exit` | `tui/ratatui/src/app.rs` + `tui/ratatui/src/main.rs` | Quits cleanly and prints the active session id after terminal restore. |

Unsupported slash commands are handled by application code. They are not sent to the model as normal prompts.

## Session Switching And Streams

When a backend command response includes a new session id, the TUI:

```text
receives AgentReply { text, session_id, command_name }
-> renders the command response in the transcript
-> updates App.session_id
-> cancels the old stream handle if one exists
-> clears stream-derived row mappings
-> starts a new stream for the active session
-> prints "system: active session <session-id>"
```

This prevents stream rows from the previous session from overwriting the new session transcript and preserves older transcript history as static text.

`/exit` does not go through the model. The terminal is restored first, then `main.rs` prints:

```text
Exited SIM-ONE Alpha TUI. Session: <active-session-id>
```

That id is the recovery token for a later `/resume`.

## Product Smoke Coverage

`pnpm run test:tui:ratatui` runs `scripts/test-ratatui-product.mjs` against packaged artifacts, not `cargo run`.

The smoke verifies:

```text
sim-one --help
sim-one skill list
sim-one tool list
sim-one worker list
sim-one mcp list
startup preflight through the packaged Ratatui path
clean transcript without scaffold scroll rows
agent greeting through the built-in greeting-preflight skill path
/new
/session
/compact
/resume
/rename
/exit
```

The smoke uses scripted prompt env vars that are intentionally scoped to tests:

```text
SIM_ONE_TUI_TEST_PROMPT
SIM_ONE_TUI_TEST_PROMPTS
SIM_ONE_TUI_TEST_STARTUP
```

These let the packaged TUI exercise prompt and slash-command paths without starting an interactive terminal.

## Where To Change Behavior

```text
Add or change backend slash command parsing:
  src/engine/commands/slash-commands.ts
  src/tests/http-endpoints.test.ts

Add or change backend slash command effects:
  src/api/routes/chat-events.ts
  src/engine/session/session-routing.ts
  src/engine/session/session-database.ts
  src/tests/http-endpoints.test.ts
  scripts/test-built-http.mjs

Change TUI command handling or session switching:
  tui/ratatui/src/app.rs
  tui/ratatui/tests/app_state.rs

Change transcript or prompt word wrapping:
  tui/ratatui/src/text_wrap.rs
  tui/ratatui/tests/app_state.rs
  tui/ratatui/tests/ui_render.rs

Change transcript or prompt styling:
  tui/ratatui/src/theme.rs
  tui/ratatui/src/app.rs
  tui/ratatui/src/ui.rs
  tui/ratatui/tests/ui_render.rs

Change TUI request payloads or response parsing:
  tui/ratatui/src/agent.rs
  tui/ratatui/tests/agent_client.rs

Change gateway launch/reuse behavior:
  tui/ratatui/src/gateway.rs
  tui/ratatui/tests/gateway_launcher.rs

Change product CLI routing:
  sim-one-cli/src/cli.tsx
  scripts/check-sim-one-product-command.mjs
  scripts/test-ratatui-product.mjs

Change packaged product verification:
  scripts/test-ratatui-product.mjs
  package.json
```

Any change to these flows should update this document, `docs/architecture/gorombo-flue-map.md`, and the relevant user/operator docs.
