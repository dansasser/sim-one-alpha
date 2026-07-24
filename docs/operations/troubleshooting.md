# Troubleshooting

Use the product diagnostics before changing files or runtime state.

```bash
sim-one doctor
sim-one status
```

`status` confirms service state. `doctor` validates whether the installed
runtime can perform its job, including gateway connectivity, model
configuration, credentials, and required local assets.

## Installation Problems

Run the packaged installer again:

```bash
curl -fsSL https://github.com/dansasser/sim-one-alpha/releases/latest/download/sim-one.sh | sh
```

The installer preserves user-owned runtime data under `~/.gorombo/` while
repairing product files and returning to onboarding.

For a source build, compare prerequisites and commands with
[Installation](../getting-started/installation.md).

## Gateway Does Not Start

Check:

```bash
sim-one status
sim-one doctor
sim-one restart
```

Confirm:

- `~/.gorombo/sim-one-alpha/gorombo.config.json` is valid JSON;
- `gateway.port` is an integer from 1 to 65535;
- the port is not occupied by another service;
- selected model cards have their required credentials;
- installed runtime files are readable by the current user.

Do not treat a running process or listening port as proof that the gateway is
working. `sim-one doctor` must complete a functional check.

## Terminal Cannot Connect

Start with:

```bash
sim-one status
sim-one doctor
sim-one
```

When connecting to a non-default gateway:

```bash
sim-one --port <number>
sim-one --base-url <url>
```

`--base-url` overrides `--port`. Verify that the URL points to the Secure Web
API and that external requests include the configured API secret.

## Model Or Credential Failure

Open the configuration:

```bash
sim-one config get models.primary
sim-one config get models.backup
```

Verify the matching credentials in `~/.gorombo/.env`.

| Model family | Credentials |
| --- | --- |
| Ollama Cloud cards | `OLLAMA_API_KEY` or `OLLAMA_CLOUD_API_KEY` |
| Codex Brain | `CODEX_BRAIN_LOCAL_API_URL` and `CODEX_BRAIN_LOCAL_API_KEY` |

The Codex Brain URL must include `/v1`. Remove an unused backup card when its
provider is intentionally not configured.

After changes:

```bash
sim-one restart
sim-one doctor
```

## Session Cannot Be Resumed

List recent sessions inside the terminal:

```text
/sessions
```

Resume by exact id or explicit name:

```text
/resume <session-id-or-name>
```

or:

```bash
sim-one --session <session-id-or-name>
```

A session is available only to its owning connector, actor, and conversation.
Duplicate explicit names are rejected rather than guessed.

## Telegram Does Not Respond

Check:

- `TELEGRAM_BOT_TOKEN` is present;
- `TELEGRAM_WEBHOOK_SECRET_TOKEN` matches the configured webhook;
- `TELEGRAM_DM_POLICY` is `pairing`, `allowlist`, or `disabled`;
- the user has completed pairing or appears in the allow list;
- group mention and user restrictions admit the message.

Use the authenticated local terminal session to inspect or approve pending
pairings. Do not place bot tokens or webhook secrets into a chat prompt.

See [Connectors And Pairing](../guides/connectors.md).

## Capability Does Not Appear

List the capability:

```bash
sim-one skill list
sim-one tool list
sim-one worker list
sim-one mcp list
```

Confirm that it is enabled, then reload the registry:

```bash
sim-one restart
sim-one doctor
```

Tools, workers, and MCP servers are disabled by default unless explicitly
enabled. Name collisions and unsafe ids fail without changing the registry.

## External API Returns `401` Or `503`

For non-loopback requests:

- configure `API_SECRET`;
- send it in the `x-api-secret` header;
- do not rely on forwarded loopback addresses to bypass authentication.

`401` means the supplied secret is wrong. `503` means external API
authentication is not configured.

See [HTTP API Reference](../reference/http-api.md).

## Memory Or Retrieval Problems

Confirm the runtime can read the databases and bundled retrieval assets:

```bash
sim-one doctor
```

Check configured paths under:

```text
~/.gorombo/db/
~/.gorombo/vector/
```

Do not edit the databases directly. Restore related state from a consistent
backup when recovery is required.

## Logs And Diagnostics

Operational diagnostics live under:

```text
~/.gorombo/logs/
```

Logs are bounded and omit prompt text, responses, selected text, secrets, and
raw credential-bearing errors. Use event categories, session ids, run ids, and
timestamps to correlate a failure with telemetry or API results.

## Recovery Order

Use this order:

1. Run `sim-one doctor`.
2. Check `sim-one status`.
3. Validate configuration and required credentials.
4. Restart with `sim-one restart`.
5. Reproduce from the local terminal.
6. Check connector, session, run, or telemetry identifiers.
7. Repair the installation only after preserving `~/.gorombo/` runtime data.

## Related Documentation

- [Installation](../getting-started/installation.md)
- [Onboarding](../getting-started/onboarding.md)
- [Configuration Reference](../reference/configuration.md)
- [Terminal And Session Guide](../guides/terminal-and-sessions.md)
- [CLI Reference](../reference/cli.md)
