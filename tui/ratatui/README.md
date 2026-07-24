# SIM-ONE Alpha Ratatui TUI

This directory contains the production local terminal client for SIM-ONE Alpha.

It is a local gateway client, not the agent runtime. It connects to the same SIM-ONE Alpha gateway used by other connectors and clients, starts the built server when needed, sends prompts to the Flue orchestrator agent, and consolidates root-orchestrator live/final assistant output into one transcript block. Nested worker response payloads remain internal to the orchestrator.

The repo-level implementation guide is `docs/architecture/tui-cli-session-flow.md`.

## Product Commands

```sh
pnpm run build:all
./.gorombo/sim-one-cli/sim-one
```

The product command is the supported launch path. It routes to the packaged Ratatui binary and preserves the capability subcommands on the same `sim-one` command.

Lower-level development commands:

```sh
pnpm run build:tui:ratatui
pnpm run test:tui:ratatui
./.gorombo/sim-one-ratatui/sim-one-ratatui-tui
```

The `build:tui:ratatui` script writes the standalone terminal binary to:

```text
.gorombo/sim-one-ratatui/sim-one-ratatui-tui
.gorombo/sim-one-ratatui/sim-one-ratatui-tui.exe on Windows
```

The Ratatui binary owns the gateway startup contract: it checks the gateway health endpoint, starts `.gorombo/sim-one-alpha/server.mjs` if needed, runs the child from the owner of the `.gorombo` runtime tree, and cleans up only a server child it started itself.

Explicit resume resolves an id or exact name to a canonical session id, loads the gateway's semantic transcript snapshot, installs its user prompts/public activity/root finals, and starts the live stream after the returned `nextOffset`. The internal startup prompt, raw tool results, nested worker responses, and local command output are not restored. Older pages prepend at scrollback without moving the current visible source row. Ratatui remains a connector client and never reads the runtime SQLite databases directly.

## Developer Checks

```sh
cargo test -p sim-one-ratatui-tui
cargo check -p sim-one-ratatui-tui
```

## Controls

```text
Type text            Edit the prompt at the cursor
Enter                Send the prompt to the orchestrator
Left/Right           Move the prompt cursor by one character
Ctrl+Left/Right      Move the prompt cursor by one word
Home/End             Move to the start/end of the prompt
Backspace/Delete     Delete around the prompt cursor
Ctrl+W               Delete the previous word
Ctrl+U               Clear the prompt
PgUp/PgDown          Scroll the transcript by a page
Up/Down              Scroll the transcript by one line
Ctrl+End             Jump the transcript back to the live tail
Ctrl+C               Copy app-selected text, or exit when nothing is selected
Esc                  Exit cleanly
```

## Slash Commands

Backend-owned commands go through `/api/chat/events`:

```text
/new [title]
/resume <session-id-or-name>
/rename <title>
/compact
```

TUI-local commands are handled in `src/app.rs`:

```text
/session
/sessions [limit]
/help
/exit
```

`/exit` restores the terminal and then prints:

```text
Exited SIM-ONE Alpha TUI. Session: <active-session-id>
```

Use that id or the exact explicit session name with `/resume <session-id-or-name>` after relaunching. At launch, `sim-one --session <selector>` accepts the same id-or-name selector; a missing launch selector creates a fresh session and greeting.

Best-effort TUI diagnostics are written to `.gorombo/logs/sim-one-ratatui.jsonl`, rotating at 1 MiB with three retained files. History events include `history.load.started`, `history.load.completed`, `history.load.failed`, `history.page.prepended`, and `stream.attach.started`. They contain typed lifecycle/input categories, counts, durations, and canonical ids, not prompt, response, selection, secret, session-name, or raw-error text.
