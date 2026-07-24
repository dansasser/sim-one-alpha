# Terminal And Session Guide

The SIM-ONE terminal interface is the secure local client for conversations,
session management, approvals, progress, and connector setup.

## Launch

Open a fresh durable session:

```bash
sim-one
```

Resume an owned session by exact id or explicit name:

```bash
sim-one --session <session-id-or-name>
```

Connect to a specific local gateway port or existing gateway URL:

```bash
sim-one --port 3940
sim-one --base-url http://127.0.0.1:3940
```

`--base-url` takes precedence over `--port`.

## Interface

The terminal interface separates conversation history from prompt entry:

- the transcript pane scrolls independently and preserves the visible context;
- the prompt editor supports multiline input without resizing the transcript;
- progress rows show orchestration, tool, worker, and approval activity;
- the status area shows the active session and connection state;
- final assistant responses replace streaming text with the authoritative
  completed response.

The terminal client sends prompts and session controls through the local
gateway. Orchestration, protocol enforcement, tools, workers, memory, and model
execution stay in the agent runtime.

## Session Behavior

A normal `sim-one` launch creates a fresh durable session. It does not silently
reuse the previous conversation. Resume is explicit through `--session` or
`/resume`.

Sessions are scoped to the connector identity that created them. A session id
from another connector, actor, or conversation is not accepted as local
terminal context.

## Slash Commands

Type `/` at the beginning of the prompt to open the command palette.

| Command | Purpose |
| --- | --- |
| `/new [title]` | Create a new durable session and switch to it |
| `/clear [title]` | Replace the active conversation with a new session while preserving the previous session |
| `/resume <session-id-or-name>` | Resume an owned session by exact id or explicit name |
| `/sessions [limit]` | List recent owned sessions; default 10, maximum 50 |
| `/session` | Show the active durable session id |
| `/rename <title>` | Assign an explicit name to the active session |
| `/compact` | Compact the active Flue session without sending command text to the model |
| `/help` | Show available terminal commands |
| `/exit` | Exit cleanly and print the active session id |

Slash commands are application controls. They are handled before ordinary
prompt text reaches the model.

## Resume And History

Resuming a session restores:

- prior user prompts;
- final root-agent responses;
- public operation, thinking, tool, and worker progress;
- the canonical session id and explicit name;
- paginated older history when requested.

Internal startup instructions, raw tool results, nested worker response bodies,
and local command-only rows are excluded from the user transcript.

Use the id printed after `/exit` to resume:

```bash
sim-one --session <session-id>
```

## Compaction

`/compact` asks the gateway to compact the active durable Flue session.
Compaction reduces context pressure while preserving the durable session and
its visible history. The command itself is not submitted as model prompt text.

## Clipboard And Scrolling

The transcript and prompt editor maintain separate scroll positions. Text
selection is copy-aware: copying a selection keeps the application open, while
an exit command closes the interface and prints the active session id.

Clipboard delivery depends on terminal and multiplexer support. Selection
remains available even when the host terminal does not accept clipboard
escape sequences.

## Related Documentation

- [CLI Reference](../reference/cli.md)
- [Configuration Reference](../reference/configuration.md)
- [Connectors And Pairing](connectors.md)
- [Troubleshooting](../operations/troubleshooting.md)
