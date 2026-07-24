# Connectors And Pairing

Connectors let SIM-ONE Alpha receive messages outside the local terminal
interface. Every connector normalizes external input into a trusted internal
event and sends it through the same governed orchestrator.

## Pair From The Local Terminal

Complete [Onboarding](../getting-started/onboarding.md) and verify the local
terminal session first. From that authenticated session, ask SIM-ONE Alpha to
connect Telegram, Discord, or another installed connector.

The connector setup flow:

1. Identifies the connector and required credentials.
2. Stores secrets in the runtime secret store.
3. Starts or validates the connector.
4. Receives a pairing request from the external account.
5. Binds approval to the connector, actor, and conversation.
6. Records the allow-list or pairing decision outside model context.
7. Confirms access from the external channel.

Connectors normalize and deliver messages. They do not bypass the orchestrator,
protocol system, approvals, or worker boundaries.

## Telegram

Telegram requires:

| Setting | Purpose |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Bot API credential |
| `TELEGRAM_WEBHOOK_SECRET_TOKEN` | Verifies webhook delivery |
| `TELEGRAM_DM_POLICY` | Direct-message admission mode |
| `TELEGRAM_ADMIN_USER_IDS` | Optional connector administrators |
| `TELEGRAM_APPROVED_USER_IDS` | Optional pre-approved users |
| `TELEGRAM_BOT_USERNAME` | Optional bot username for mention handling |
| `TELEGRAM_MENTION_PATTERNS` | Optional group mention patterns |

The default direct-message policy is `pairing`.

| Policy | Behavior |
| --- | --- |
| `pairing` | Unknown users receive a time-limited pairing flow |
| `allowlist` | Only stored or configured allowed users are admitted |
| `disabled` | Direct messages are rejected |

### Pair A Telegram User

1. Send a direct message to the configured bot.
2. Receive the pairing code or request.
3. Return to the authenticated local SIM-ONE Alpha session.
4. Ask SIM-ONE Alpha to approve the pending Telegram pairing.
5. Send another Telegram message after approval.

Pairing codes expire and are accepted only for the pending request they
identify. Approval creates an allow-list record for the Telegram user and chat.

### Telegram Groups

Group access is configured per group. A group can require a bot mention and can
restrict messages to an explicit user list.

Group configuration is stored in the connector database, not in prompt text.
Removing a group or user takes effect at the connector admission layer.

## Web API

External applications can use the Secure Web API. Non-loopback clients send
the configured `API_SECRET` in the `x-api-secret` header. The generic chat
ingress accepts only `web-api` and `tui` connector identities; callers cannot
claim Telegram or another trusted connector by changing a JSON field.

See the [HTTP API Reference](../reference/http-api.md) for routes and request
requirements.

## Scheduled Execution

Scheduled jobs enter through the orchestrator and use the same protocols,
memory, capability boundaries, and progress reporting as interactive work.
Schedule definitions and run history are stored in SQLite.

## Connector Security

- Pairing and allow lists are enforced before model execution.
- Connector identity comes from verified ingress, not model-selected text.
- Secrets remain in the runtime environment or secret manager.
- The orchestrator loads applicable protocols before acting.
- Mutating work still uses approval-gated execution paths.
- Connector-specific replies return through the initiating channel.

## Related Documentation

- [Onboarding](../getting-started/onboarding.md)
- [Configuration Reference](../reference/configuration.md)
- [HTTP API Reference](../reference/http-api.md)
- [Architecture Overview](../architecture/overview.md)
- [Troubleshooting](../operations/troubleshooting.md)
