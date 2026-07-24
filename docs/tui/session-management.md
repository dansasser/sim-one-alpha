# TUI Session Management

The Ratatui TUI keeps SIM-ONE Alpha conversations in durable gateway sessions. The TUI is only the terminal surface; session creation, resume checks, rename, compaction, and model execution stay behind the gateway and Flue runtime.

Implementation details live in `docs/architecture/tui-cli-session-flow.md`.

## Session Model

The TUI sends chat events with connector `tui` and a stable `local-tui` actor/conversation/thread scope. The gateway uses that scope for ownership checks and scoped session listing; it does not use it as an implicit last-session pointer. Only Telegram currently has connector-conversation persistence.

A no-argument TUI launch calls `POST /api/chat/sessions` and always receives a newly created durable `tui-*` id. The TUI attaches the Flue event stream and sends the startup greeting as that session's first normal prompt. Existing TUI context is entered through an exact id or explicit name with `sim-one --session <selector>` or `/resume <session-id-or-name>`.

When the active session changes, the TUI cancels the old stream handle, clears stream activity rows for the previous live session, and starts a new stream for the selected session.

Normal no-argument launch does not use a default `primary` session and never reuses the previous launch. `--session <selector>` validates ownership before stream attachment, resolves an exact explicit name to its canonical `tui-*` id, restores the name, and adds no startup greeting to the resumed context. If no owned session matches the selector, startup creates a fresh session and performs the normal greeting. Cross-scope ids remain forbidden, and duplicate names return a conflict instead of choosing one.

Launch examples:

```sh
./.gorombo/sim-one-cli/sim-one
./.gorombo/sim-one-cli/sim-one --session tui-2026-...
```

## Discover Session Commands

Type `/` at the beginning of the prompt to open the TUI command palette. Continue typing to filter commands, use `Up` and `Down` to change the highlighted command, then press `Enter` or `Tab` to insert it. The palette lists each session command with its arguments and purpose. It overlays the transcript and does not change the current scroll position.

## Current Session

Use:

```text
/session
```

The TUI prints the current active session id into the transcript:

```text
system: current session <session-id>
```

The status bar starts with `session: <session-id>`. Renaming replaces that same field with `session: <title>` as soon as the gateway confirms the explicit name. `/session` still prints the durable id into the transcript.

The transcript header is `SIM-ONE Alpha` for an unnamed session and `SIM-ONE Alpha - <name>` for an explicitly named session. Loading or resuming a named session restores that header without changing the status-bar format.

## Start A New Session

Use:

```text
/new [title]
```

The gateway creates a new durable TUI session. The TUI switches to the returned session id and restarts the stream.

Example:

```text
/new Release polish
```

Expected transcript shape:

```text
assistant: Started new session tui-...
system: active session tui-...
```

## Clear The Current Thread

Use:

```text
/clear [title]
```

`/clear` replaces the current TUI conversation with a newly created durable session and switches the stream to it. Previous sessions remain stored and can be resumed by id.

Expected transcript shape:

```text
assistant: Cleared conversation. Started new session tui-...
system: active session tui-...
```

## Resume A Session

Use:

```text
/resume <session-id-or-name>
```

The gateway resolves an exact id or explicit name, validates that the session belongs to the local TUI actor/conversation scope, then switches the TUI to its canonical id and restarts the stream. A missing in-app selector returns an error and leaves the active session unchanged.

Example:

```text
/resume tui-abc123
/resume Release testing
```

Expected transcript shape:

```text
assistant: Resumed session tui-abc123.
system: active session tui-abc123
```

### What Resume Restores

Resume installs the canonical id and exact explicit name returned by the lifecycle API, then loads the durable transcript before accepting a new prompt. The restored transcript contains prior visible user prompts, final root-assistant responses, and settled public operation, thinking, tool, and task activity. The original agent greeting remains visible, but resume sends no new greeting prompt.

The restored view excludes the internal startup instruction, raw tool result bodies, nested worker assistant output, empty tool-call messages, and local command-only rows such as `/help`, `/sessions`, `/session`, and `/exit`. Older pages load when scrollback reaches the first loaded exchange and are prepended without moving the row currently under the viewport.

After the initial snapshot is installed, the live Flue stream starts at the snapshot's returned offset. Replayed catch-up events and reconnect batches are matched by stable submission/activity ids, so they update the same exchange rather than duplicating prior prompts, activities, or final responses.

## List Sessions

Use:

```text
/sessions [limit]
```

The default limit is 10. Values are clamped from 1 to 50.

Example:

```text
/sessions 20
```

Each row includes session id, origin, title, and updated time:

```text
system: recent sessions
system: tui-abc123 | tui | Release polish | 2026-07-06T...
```

## Rename A Session

Use:

```text
/rename <title>
```

The gateway renames the active durable session. The command is not sent to the model.

Example:

```text
/rename MVP TUI testing
```

Expected transcript shape:

```text
assistant: Renamed session <session-id> to "MVP TUI testing".
```

## Compact A Session

Use:

```text
/compact
```

The gateway opens the active durable Flue session and calls Flue session compaction. The command is not sent as model prompt text.

Expected transcript shape:

```text
assistant: Compacted session <session-id>.
```

## Copy And Exit

`Ctrl+C` is selection-aware. When prompt or transcript text is selected, it copies that selection through OSC52 and keeps the TUI open. With no application selection, `Ctrl+C` exits. This lets terminal selection and process control share the conventional key without turning a transcript copy into an accidental shutdown.

## Exit And Recover The Session Id

Use:

```text
/exit
```

The TUI restores the terminal and prints the active session id after exit:

```text
Exited SIM-ONE Alpha TUI. Session: <active-session-id>
```

Use that id or the session's exact explicit name with `sim-one --session <selector>` the next time you launch the TUI. Use `/resume <session-id-or-name>` to switch from another session while the TUI is already running.

## Command Reference

```text
/new [title]           create a new durable TUI session and switch to it
/clear [title]         clear the active TUI thread by creating a new active session
/resume <session-id-or-name> resume an available durable session and switch to it
/sessions [limit]      list recent sessions, default 10, max 50
/session               show the current active session id
/rename <title>        rename the active durable session
/compact               compact the active durable Flue session
/help                  print the TUI command list
/exit                  close the TUI and print the active session id
```

## Diagnostics Log

The packaged TUI writes best-effort structured JSONL diagnostics to `.gorombo/logs/sim-one-ratatui.jsonl` in the installed runtime tree, even when launched from another working directory. `SIM_ONE_TUI_LOG_PATH` overrides the location for tests or support collection. The file rotates at 1 MiB and retains three older files.

Diagnostics record launch mode, gateway start versus reuse, session lifecycle outcomes, canonical session ids, Ctrl+C copy versus exit, clipboard failures, and application exit. Transcript replay adds `history.load.started`, `history.load.completed`, `history.load.failed`, `history.page.prepended`, and `stream.attach.started`. They classify selectors as id or name and record only counts, elapsed time, modes, and failure categories; they never store selector text, prompt text, selected text, responses, secrets, or raw gateway errors.
