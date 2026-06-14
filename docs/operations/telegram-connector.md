# Telegram Connector — Operations Guide

This guide covers running and administering the native Telegram ingress/egress connector in GOROMBO Agent.

## What it does

- Long-polls the Telegram Bot API for messages.
- Enforces an access gate for direct messages (DMs) and groups.
- Delivers approved messages to the durable orchestrator agent.
- Sends the orchestrator's text response back to Telegram.
- Supports attachments downloaded to a local inbox.

## Prerequisites

1. Create a bot with [@BotFather](https://t.me/botfather) and copy the bot token.
2. For group delivery:
   - Disable **Group Privacy** in BotFather (`/setprivacy` → `Disable`).
   - Remove and re-add the bot to the group so it can read messages.
3. Choose one deployment environment per bot token. Telegram allows only one active `getUpdates` consumer per token.

## Configuration

### Environment variables

```bash
TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
TELEGRAM_APPROVED_USER_IDS=6653274440,123456789
# optional
TELEGRAM_BOT_USERNAME=mygorombobot
TELEGRAM_DM_POLICY=pairing
TELEGRAM_MENTION_PATTERNS=gorombo,bot
TELEGRAM_INBOX_DIR=/var/gorombo/telegram-inbox
```

### Runtime config

Add a `connectors.telegram` block to `src/config/gorombo.config.json`:

```json
{
  "version": 1,
  "models": { ... },
  "connectors": {
    "telegram": {
      "enabled": true,
      "dmPolicy": "pairing",
      "approvedUserIds": ["6653274440"],
      "groups": {
        "-1003884375753": { "requireMention": true }
      }
    }
  }
}
```

`enabled` is true only when `TELEGRAM_BOT_TOKEN` is set. `dmPolicy` can be `pairing`, `allowlist`, or `disabled`.

## DM policies

| Policy | Behavior |
|--------|----------|
| `pairing` (default) | Unknown senders receive a 6-character pairing code and must be approved by an admin. |
| `allowlist` | Only users in the allowlist (config + runtime DB) are served. Unknown senders are silently dropped. |
| `disabled` | All Telegram DMs are dropped. |

Runtime policy changes via the admin API take effect immediately for the next update.

## Pairing workflow

1. Unknown user sends any message to the bot.
2. Bot replies with: `Pairing required — ask an admin to run: openclaw pairing approve telegram <code>`
3. Admin calls `POST /api/connectors/telegram/pair { code }`.
4. Bot sends the user a welcome message. The user's next message is delivered.

## Admin HTTP API

All routes require the `x-api-secret` header.

```bash
export API_SECRET=$(grep API_SECRET .env | cut -d= -f2)

# Status
GET /api/connectors/telegram/status

# Health
GET /api/connectors/telegram/health

# Approve a pairing code
POST /api/connectors/telegram/pair
{ "code": "a4f91c" }

# Deny/delete a pairing code
POST /api/connectors/telegram/deny
{ "code": "a4f91c" }

# Directly allow a user
POST /api/connectors/telegram/allow
{ "userId": "6653274440", "chatId": "6653274440" }

# Remove a user (notify=true sends a Telegram message)
POST /api/connectors/telegram/remove
{ "userId": "6653274440", "notify": true }

# Switch DM policy at runtime
POST /api/connectors/telegram/policy
{ "dmPolicy": "disabled" }

# Configure a group
POST /api/connectors/telegram/group
{ "groupId": "-1003884375753", "requireMention": true, "allowFrom": ["6653274440"] }

# List configured groups
GET /api/connectors/telegram/groups

# Remove a group
DELETE /api/connectors/telegram/group/-1003884375753
```

## Group setup

1. Add the bot to the group.
2. Call `POST /api/connectors/telegram/group` with the group ID.
3. If `requireMention` is true, the bot only responds when:
   - Mentioned as `@botusername`.
   - The message is a reply to one of the bot's messages.
   - The message text matches one of the configured `TELEGRAM_MENTION_PATTERNS` (case-insensitive word match).
4. If `allowFrom` is set, only those user IDs can trigger responses, even if other members can mention the bot.

## Attachment inbox

Photos, documents, voice, audio, video, video notes, and stickers are downloaded to `.gorombo/telegram-inbox/` (or `TELEGRAM_INBOX_DIR`). Local paths are attached to the normalized event under `event.raw.__goromboAttachmentPaths`.

## Deployment notes

- **One poller per token.** Running two GOROMBO Agent processes with the same token will cause `409 Conflict` from Telegram.
- **IPv4-first DNS.** Telegram's API can silently hang on IPv6 in some environments. Start the process with:
  ```bash
  NODE_OPTIONS=--dns-result-order=ipv4first node dist/server.mjs
  ```
- **Graceful shutdown.** `SIGTERM`/`SIGINT` aborts the in-flight `getUpdates` request and waits for any in-progress orchestrator delivery to finish.

## Observability

Structured events are written to stderr:

```text
telegram:poller:start {"username":"mygorombobot"}
telegram:update:received ...
telegram:gate:pair {"senderId":"...","chatId":"...","code":"..."}
telegram:reply:sent {"chatId":"...","messageId":123}
telegram:poller:error {"error":"..."}
```

The health endpoint returns:

- `enabled` — connector configured and started
- `pollerRunning` — poller loop is active
- `lastUpdateReceivedAt` — ISO timestamp of the last Telegram update
- `updateCount` — total updates received this run
- `errorCount` — total errors this run
- `pendingPairingCount` — active pending codes
- `allowedUserCount` — approved users

## Verifying it is working

Do not rely on `ps` or port checks. Verify end-to-end:

1. Check `/api/connectors/telegram/health` returns `enabled: true` and a recent `lastUpdateReceivedAt` after sending a message.
2. Send a message from an approved user and confirm a Telegram reply arrives.
3. Check stderr for `telegram:reply:sent` without a following `telegram:reply:failed`.

## Limitations

- Only long-polling is supported; webhooks are not implemented.
- Inline queries, edited messages, channel posts, and reactions are ignored.
