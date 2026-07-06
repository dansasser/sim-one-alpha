# TUI, CLI, And Session Flow

This document is the repository-level map for the SIM-ONE Alpha terminal surface. It explains how the `sim-one` command, Ratatui TUI, gateway launcher, slash commands, durable sessions, and product smoke tests fit together.

User-facing command reference lives in `docs/tui/ratatui.md` and `docs/tui/session-management.md`. Operator runbook details live in `docs/operations/product-tui.md`.

## Ownership

```text
sim-one-cli/
  Product command wrapper.
  Owns command routing for `sim-one`, `sim-one --help`, and capability subcommands.
  No-argument `sim-one` launches the Ratatui binary.
  `--ink` remains a legacy fallback path only.

tui/ratatui/
  Rust/Ratatui terminal client.
  Owns terminal drawing, input mapping, transcript scroll state, prompt editing, local TUI commands, gateway launch/reuse, stream attach/restart, and packaged binary behavior.

src/api/routes/chat-events.ts
  App-owned connector-style chat ingress.
  Owns `/api/chat/events`, `/api/chat/sessions`, trusted event persistence, session resolution, pre-LLM slash command handling, and durable prompt admission to the Flue orchestrator route.

src/engine/commands/slash-commands.ts
  Shared pre-LLM slash command parser.

src/engine/session/
  Product session catalog, access checks, Flue session persistence wrapper, compaction budget, direct-agent instance indexes, and session-memory indexing.

scripts/test-ratatui-product.mjs
  Packaged product smoke for the exact built `sim-one` path.
```

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

## Prompt Flow

Normal prompts from the Ratatui TUI use the connector-style chat path:

```text
TUI prompt submit
-> POST /api/chat/events
   connector: "tui"
   actorId: "local-tui"
   conversationId: "local-tui"
   threadId: "local-tui"
   session: <active-session-id>
-> persist trusted normalized event context
-> resolve product session
-> POST /agents/orchestrator/:sessionId?wait=result
-> Flue durable direct-agent submission
-> response text rendered in the transcript
```

The stable `local-tui` actor/conversation/thread scope is intentional. The active session id selects the durable conversation, while the stable scope lets `/new`, `/resume`, `/rename`, and `/compact` operate across session switches without creating unreachable conversation scopes.

## Slash Commands

Slash commands are parsed before prompt text reaches the LLM.

Backend-owned commands:

| Command | Owner | Behavior |
| --- | --- | --- |
| `/new [title]` | `src/api/routes/chat-events.ts` | Creates a new durable TUI session, returns its id, and the TUI switches to it. |
| `/resume <session-id>` | `src/api/routes/chat-events.ts` | Validates session access for the TUI actor/conversation scope, returns the session, and the TUI switches to it. |
| `/rename <title>` | `src/api/routes/chat-events.ts` | Renames the active durable session. |
| `/compact` | `src/api/routes/chat-events.ts` | Opens the active durable Flue session and calls `session.compact()` without sending `/compact` to the model. |

TUI-local commands:

| Command | Owner | Behavior |
| --- | --- | --- |
| `/session` | `tui/ratatui/src/app.rs` | Prints the current active session id. |
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
real prompt submission through the packaged Ratatui path
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
