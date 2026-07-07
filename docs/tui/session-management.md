# TUI Session Management

The Ratatui TUI keeps SIM-ONE Alpha conversations in durable gateway sessions. The TUI is only the terminal surface; session creation, resume checks, rename, compaction, and model execution stay behind the gateway and Flue runtime.

Implementation details live in `docs/architecture/tui-cli-session-flow.md`.

## Session Model

The TUI sends chat events with connector `tui` and a stable local TUI actor/conversation scope. The active session id selects the durable SIM-ONE Alpha conversation to prompt, stream, compact, or resume.

When the active session changes, the TUI cancels the old stream handle, clears stream activity rows for the previous live session, and starts a new stream for the selected session.

Normal no-argument launch creates a fresh startup session automatically before stream attach. This keeps the first screen clean and prevents old `primary` stream catch-up rows from appearing. Use `--session <id>` at launch or `/resume <session-id>` inside the TUI when you intentionally want prior session context.

## Current Session

Use:

```text
/session
```

The TUI prints the current active session id into the transcript:

```text
system: current session <session-id>
```

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

## Resume A Session

Use:

```text
/resume <session-id>
```

The gateway validates that the session belongs to the local TUI actor/conversation scope. If it is available, the TUI switches to it and restarts the stream.

Example:

```text
/resume tui-abc123
```

Expected transcript shape:

```text
assistant: Resumed session tui-abc123.
system: active session tui-abc123
```

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

## Exit And Recover The Session Id

Use:

```text
/exit
```

The TUI restores the terminal and prints the active session id after exit:

```text
Exited SIM-ONE Alpha TUI. Session: <active-session-id>
```

Use that id with `/resume <session-id>` the next time you launch the TUI.

## Command Reference

```text
/new [title]           create a new durable TUI session and switch to it
/resume <session-id>   resume an available durable session and switch to it
/sessions [limit]      list recent sessions, default 10, max 50
/session               show the current active session id
/rename <title>        rename the active durable session
/compact               compact the active durable Flue session
/help                  print the TUI command list
/exit                  close the TUI and print the active session id
```
