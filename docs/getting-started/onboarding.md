# Onboarding

Onboarding takes a new SIM-ONE Alpha installation from the installer to the
first authenticated conversation. It is the recommended place to configure
credentials and enable services.

## Start Onboarding

The packaged installer opens onboarding automatically. To run it again:

```bash
sim-one install
```

On a source build, use:

```bash
./.gorombo/sim-one-cli/sim-one install
```

## Onboarding Flow

The onboarding interface walks through:

1. Runtime location and configuration validation.
2. Primary and optional backup model selection.
3. Model-provider API keys.
4. Agent and service tokens for enabled integrations.
5. Gmail application authorization when Gmail is enabled.
6. Optional research, image-generation, and external-service credentials.
7. Local gateway startup and health checks.
8. The first secure terminal session with SIM-ONE Alpha.

Secrets are written to `~/.gorombo/.env` or the configured deployment secret
store. Model selection and non-secret runtime behavior are written to
`~/.gorombo/sim-one-alpha/gorombo.config.json`. Secrets are not written into
the agent workspace or stored as conversation text.

## First Conversation

After validation, onboarding opens the SIM-ONE terminal interface. The first
session is the secure local control point for finishing setup.

Use that conversation to:

- verify the selected model responds;
- confirm the agent identity and workspace context;
- connect communication channels;
- approve connector users and conversations;
- add optional capabilities.

The local terminal session is established before remote connector pairing so
connector access can be admitted from an authenticated local surface.

## Pair Connectors

From the first terminal session, ask SIM-ONE Alpha to connect Telegram,
Discord, or another installed connector. SIM-ONE Alpha gathers the
connector-specific settings, validates access, and guides pairing.

Connector credentials remain in the runtime secret store. Pairing and
allow-list records remain in product-owned storage outside the model context.

See [Connectors And Pairing](../guides/connectors.md) for the connector trust
model and Telegram controls.

## Validate The Result

After onboarding:

```bash
sim-one doctor
sim-one status
sim-one
```

The installation is ready when:

- the doctor check reports a valid runtime and model configuration;
- the gateway reports healthy;
- the terminal interface can create a fresh session;
- the orchestrator returns a response;
- each enabled remote connector accepts only paired or allowed users.

## Reconfigure Later

Use the product configuration commands for normal changes:

```bash
sim-one config get <key>
sim-one config set <key> <value>
sim-one restart
sim-one doctor
```

Run `sim-one install` again when an integration requires an interactive
authorization flow.

## Related Documentation

- [Installation](installation.md)
- [Configuration Reference](../reference/configuration.md)
- [Terminal And Session Guide](../guides/terminal-and-sessions.md)
- [Connectors And Pairing](../guides/connectors.md)
- [Troubleshooting](../operations/troubleshooting.md)
