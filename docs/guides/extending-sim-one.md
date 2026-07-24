# Extending SIM-ONE Alpha

SIM-ONE Alpha combines product-shipped Flue capabilities with runtime
capabilities added by a user or the agent.

## Two Capability Layers

| Layer | Contents | Lifecycle |
| --- | --- | --- |
| Built-in Flue layer | Product skills, tools, workers, workflows, and MCP connections | Shipped with the product |
| SIM-ONE runtime registry | User- or agent-added skills, tools, workers, and MCP servers | Stored outside the product artifact and loaded after restart |

Both layers enter the same Flue skill, tool, and subagent surfaces. The runtime
registry adds extensibility without giving installed capabilities authority
over protocols or approvals.

## Capability Types

| Type | Purpose | Default |
| --- | --- | --- |
| Skill | Reusable instructions, procedures, and supporting resources | Enabled when added |
| Tool | Typed executable action attached to an owning agent | Disabled unless enabled |
| Worker | Specialized executor loaded as a Flue subagent profile | Disabled unless enabled |
| MCP server | Remote HTTP or HTTPS service contributing tools | Disabled unless enabled |

Protocols are not capabilities. Protocols are mandatory runtime rules stored in
SQLite and loaded through the Protocol Tool.

## Registry And Files

The authoritative registry is:

```text
~/.gorombo/db/capabilities.sqlite
```

File-backed capabilities are materialized under:

```text
~/.gorombo/capabilities/skills/<id>/
~/.gorombo/capabilities/tools/<id>/
~/.gorombo/capabilities/workers/<id>/
```

MCP definitions store their endpoint, transport, and token
environment-variable name in SQLite. MCP tokens remain in the environment.

Capability records and managed files live outside the installed product
artifact, so product upgrades preserve runtime additions.

## Sources And Versions

Skills, tools, and workers accept:

- an HTTPS Git repository URL;
- another supported Git remote;
- a local directory path.

`--version` pins a remote branch, tag, or version reference. Local directory
sources ignore version pins.

Capability ids must be safe slugs and cannot collide with built-in or existing
runtime capability names.

## Add A Skill

```bash
sim-one skill add <source> <id> "<name>" \
  [--description "<text>"] [--version <version-or-git-ref>] [--enable]
```

Skills are enabled when added because they contain workflow knowledge rather
than executable capability.

## Add A Tool

```bash
sim-one tool add <source> <id> "<name>" \
  [--description "<text>"] [--version <version-or-git-ref>] [--enable]
```

Tools remain disabled unless explicitly enabled.

## Add A Worker

```bash
sim-one worker add <source> <id> "<name>" \
  [--description "<text>"] [--version <version-or-git-ref>] [--enable]
```

Workers remain disabled unless explicitly enabled.

## Add An MCP Server

```bash
sim-one mcp add <id> "<name>" --url <url> \
  [--transport <streamable-http|sse>] [--token-env <ENV_NAME>] \
  [--description "<text>"] [--enable]
```

The URL must use HTTP or HTTPS. `streamable-http` is the default transport.
`--token-env` records the name of the secret-bearing environment variable.

## Manage Capabilities

Each capability family supports:

```text
list
enable <id>
disable <id>
update <id>
remove <id>
```

Updating a skill, tool, or worker re-fetches its recorded source. Removing it
deletes the registry record and managed files. MCP update refreshes stored
connection metadata; MCP removal deletes the connection record.

Apply lifecycle changes with:

```bash
sim-one restart
```

## Agent-Added Capabilities

The agent can propose or add runtime capabilities through governed tools:

- skills can be enabled immediately;
- executable tools, workers, and MCP servers require approval before
  activation;
- all additions are checked for identity, scope, source validity, and name
  collisions.

Registration does not grant unrestricted authority. Enabled capabilities
remain subject to:

- the active SQLite protocol bundle;
- trusted connector, actor, conversation, and project scope;
- typed tool boundaries;
- worker ownership and isolation;
- orchestrator/critic validation;
- approval-gated mutations.

## Verify An Addition

```bash
sim-one <skill|tool|worker|mcp> list
sim-one restart
sim-one doctor
```

Then open a new terminal session and confirm the capability is available to its
owning agent.

## Related Documentation

- [CLI Reference](../reference/cli.md)
- [Configuration Reference](../reference/configuration.md)
- [Architecture Overview](../architecture/overview.md)
