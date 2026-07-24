# CLI Reference

`sim-one` is the product command for onboarding, terminal access,
configuration, diagnostics, service control, and runtime capabilities.

## Product Commands

| Command | Purpose |
| --- | --- |
| `sim-one` | Open the terminal interface in a fresh durable session |
| `sim-one install` | Open onboarding and integration authorization |
| `sim-one doctor` | Validate installation, gateway, models, credentials, and runtime assets |
| `sim-one config get <key>` | Read a runtime configuration value |
| `sim-one config set <key> <value>` | Set a runtime configuration value |
| `sim-one status` | Show installed gateway service status |
| `sim-one start` | Start the installed gateway service |
| `sim-one restart` | Restart the installed gateway service |
| `sim-one stop` | Stop the installed gateway service |
| `sim-one --help` | Show CLI help |

## Terminal Options

| Option | Purpose |
| --- | --- |
| `--session <selector>` | Resume an owned session by exact id or explicit name |
| `--port <number>` | Use a local gateway port from 1 to 65535 |
| `--base-url <url>` | Connect to an existing gateway URL; overrides `--port` |
| `-h`, `--help` | Show command help |

Examples:

```bash
sim-one
sim-one --session "Quarterly planning"
sim-one --port 3940
sim-one --base-url http://127.0.0.1:3940
```

## Skill Commands

```bash
sim-one skill add <source> <id> "<name>" \
  [--description "<text>"] [--version <version-or-git-ref>] [--enable]
sim-one skill list
sim-one skill enable <id>
sim-one skill disable <id>
sim-one skill update <id>
sim-one skill remove <id>
sim-one skill --help
```

Skills accept a Git repository URL or local directory source and are enabled
when added.

## Tool Commands

```bash
sim-one tool add <source> <id> "<name>" \
  [--description "<text>"] [--version <version-or-git-ref>] [--enable]
sim-one tool list
sim-one tool enable <id>
sim-one tool disable <id>
sim-one tool update <id>
sim-one tool remove <id>
sim-one tool --help
```

Tools are disabled when added unless `--enable` is supplied.

## Worker Commands

```bash
sim-one worker add <source> <id> "<name>" \
  [--description "<text>"] [--version <version-or-git-ref>] [--enable]
sim-one worker list
sim-one worker enable <id>
sim-one worker disable <id>
sim-one worker update <id>
sim-one worker remove <id>
sim-one worker --help
```

Workers are disabled when added unless `--enable` is supplied.

## MCP Commands

```bash
sim-one mcp add <id> "<name>" --url <url> \
  [--transport <streamable-http|sse>] [--token-env <ENV_NAME>] \
  [--description "<text>"] [--enable]
sim-one mcp list
sim-one mcp enable <id>
sim-one mcp disable <id>
sim-one mcp update <id>
sim-one mcp remove <id>
sim-one mcp --help
```

`--url` is required and must use HTTP or HTTPS. The default transport is
`streamable-http`; `sse` is also supported. `--token-env` stores the
environment-variable name, not the token.

## Capability Lifecycle

After adding, enabling, disabling, updating, or removing a capability:

```bash
sim-one restart
```

The restart reloads enabled capability records. It does not rebuild the
product.

See [Extending SIM-ONE Alpha](../guides/extending-sim-one.md) for source,
trust, approval, collision, and persistence behavior.

## Terminal Slash Commands

Slash commands are entered inside the terminal interface, not in the shell.

| Command | Purpose |
| --- | --- |
| `/new [title]` | Create and enter a new durable session |
| `/clear [title]` | Replace the active thread with a new session |
| `/resume <session-id-or-name>` | Resume an owned session |
| `/sessions [limit]` | List recent sessions |
| `/session` | Print the active session id |
| `/rename <title>` | Rename the active session |
| `/compact` | Compact the active durable session |
| `/help` | Show terminal commands |
| `/exit` | Exit and print the active session id |

See [Terminal And Session Guide](../guides/terminal-and-sessions.md) for session
semantics and restored history.

## Exit Status And Errors

Invalid options, missing required arguments, unsafe capability ids, capability
name collisions, invalid MCP URLs, and invalid token environment-variable
names fail without changing the runtime registry.

Use:

```bash
sim-one doctor
sim-one status
```

for installation and gateway diagnostics.
