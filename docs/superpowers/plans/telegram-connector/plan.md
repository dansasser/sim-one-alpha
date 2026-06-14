# Telegram Connector Plan — GOROMBO Agent

## Goal

Add native Telegram ingress and egress to **GOROMBO Agent** (the runtime product built in `astro-flue-agent`). A Telegram bot token and one or more approved user IDs are configured through the existing runtime config and environment variables. Unapproved users trigger a pairing flow. Approved Telegram messages reach the orchestrator agent through the same durable path that `/api/chat/events` already uses. The orchestrator replies through a model-callable tool.

## First principle: use Flue before building our own

Flue already provides:

- `createAgent`, `defineTool`, `dispatch` from `@flue/runtime`.
- Durable agent sessions through the `src/db.ts` adapter.
- Hono routing with `app.route('/', flue())`.
- Continuing agent instances keyed by an `id`.

Therefore:

- Telegram messages enter as **app-owned ingress**, not a separate gateway.
- Approved messages are delivered by reusing the existing durable orchestrator session path (`/agents/orchestrator/:sessionId`) or by Flue `dispatch(...)`.
- Outbound replies are a `defineTool(...)` attached to the orchestrator agent.
- Pairing/allowlist state is stored in the existing SQLite session database so it is durable and consistent with other session state.

## Architecture

```text
Telegram Bot API (long-poll or webhook)
  -> src/connectors/telegram-ingress.ts
     -> access gate (pairing / allowlist / disabled)
     -> normalizeTelegramUpdate()
     -> GoromboSessionDatabase.recordNormalizedMessageEvent()
     -> resolveChatSession({ connector: 'telegram', ... })
     -> POST /agents/orchestrator/:sessionId?wait=result
        -> orchestrator agent
           -> load_protocols
           -> retrieve_memory
           -> reasoning / delegation
           -> telegram_reply tool
              -> Telegram Bot API sendMessage
```

The entire flow runs inside the single Node process produced by `flue build --target node` and started with `pnpm start`. No separate gateway process.

## Phase 0 — Shared types and runtime config

### Files

- `src/types/core.ts` — extend `ConnectorKind` if needed (already includes `'telegram'`).
- `src/config/gorombo-config.ts` — add typed `connectors?: { telegram?: TelegramConnectorConfig }` block.
- `src/config/gorombo.config.json` — add a commented-out `connectors.telegram` example.
- `.env.example` — add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_APPROVED_USER_IDS`.

### Config shape

```json
{
  "version": 1,
  "models": { ... },
  "storage": { ... },
  "connectors": {
    "telegram": {
      "enabled": true,
      "dmPolicy": "pairing",
      "botToken": "env:TELEGRAM_BOT_TOKEN",
      "approvedUserIds": ["6653274440"],
      "groups": {
        "-1003884375753": { "requireMention": true }
      }
    }
  }
}
```

Token resolution order:

1. Environment variable named by `botToken` (if it starts with `env:`).
2. Raw string value in config.
3. `TELEGRAM_BOT_TOKEN` env fallback.

`approvedUserIds` is the static allowlist for the first slice. Pairing adds users at runtime.

## Phase 1 — Telegram ingress service

### New file

- `src/connectors/telegram-ingress.ts`

### Responsibilities

1. Read the resolved `TelegramConnectorConfig` and `TELEGRAM_BOT_TOKEN`.
2. Start a raw `getUpdates` long-poll loop when `enabled` is true.
3. Handle `message` updates with text, photo, document, voice, audio, video, sticker.
4. On every update, run the access gate. If the gate returns `pair`, reply with a 6-character pairing code and drop the message.
5. If the gate returns `deliver`, call the existing `normalizeTelegramUpdate()`.
6. Persist the normalized event with `goromboPersistenceRuntime.sessionDatabase.recordNormalizedMessageEvent()`.
7. Resolve the chat session with `resolveChatSession()` — this already treats `telegram` as a connector surface.
8. Prompt the durable orchestrator route (`/agents/orchestrator/:sessionId?wait=result`) with `createChatPrompt(event)`.
9. Send the orchestrator's text response back to Telegram.

### Synchronous vs asynchronous delivery

For the first slice, deliver synchronously so failures are visible immediately:

```ts
const response = await app.request(
  `/agents/orchestrator/${encodeURIComponent(sessionResolution.sessionId)}?wait=result`,
  { ... }
);
const body = await response.json();
await sendTelegramMessage(chatId, body.result?.text);
```

Later we may switch to Flue `dispatch(...)` for true asynchronous processing, but synchronous delivery reuses the exact path already proven by `src/routes/chat-events.ts`.

### Photos and documents

- Defer download until after the gate approves delivery.
- Download to a configurable inbox directory (default `.gorombo/telegram-inbox/`).
- Put the local path in `event.raw.imagePath` or `event.raw.attachment` so the orchestrator can read it.

## Phase 2 — Access control + pairing store

### New tables in `src/session/session-database.ts`

```sql
CREATE TABLE telegram_allowed_users (
  user_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  added_at TEXT NOT NULL
);

CREATE TABLE telegram_pending_pairings (
  code TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  replies INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE telegram_groups (
  group_id TEXT PRIMARY KEY,
  require_mention INTEGER NOT NULL DEFAULT 1,
  allow_from TEXT  -- JSON array, empty = any member
);
```

### Access gate rules

- `dmPolicy: 'disabled'` — drop all Telegram messages.
- `dmPolicy: 'allowlist'` — only deliver if `user_id` is in `telegram_allowed_users`.
- `dmPolicy: 'pairing'` (default):
  - If `user_id` is allowed, deliver.
  - If not, generate `randomBytes(3).toString('hex')` (6 hex chars).
  - Store in `telegram_pending_pairings` with 1-hour expiry.
  - Reply: "Pairing required — provide code `a4f91c` to an admin."
  - Drop the original message.
- Group messages:
  - Group must exist in `telegram_groups`.
  - If `requireMention` is true, only deliver on `@botusername` mention, reply to bot, or configured mention patterns.
  - If per-group `allow_from` is non-empty, sender must be in it.

### Pairing approval

- Admin calls `POST /api/connectors/telegram/pair { code }` with the API secret.
- Server looks up the pending code.
- If valid and not expired:
  - Insert into `telegram_allowed_users`.
  - Delete the pending row.
  - Send a confirmation Telegram message.
  - Return `{ approved: true, userId, chatId }`.

## Phase 3 — Admin routes

### New file

- `src/routes/telegram-admin.ts`

### Routes

All protected by `requireApiSecret`.

- `GET /api/connectors/telegram/status`
  - enabled/disabled, dmPolicy, allowed user count, pending codes with age, configured groups.
- `POST /api/connectors/telegram/pair`
  - Body: `{ code }`.
  - Approves a pending pairing.
- `POST /api/connectors/telegram/deny`
  - Body: `{ code }`.
  - Deletes a pending pairing.
- `POST /api/connectors/telegram/allow`
  - Body: `{ userId, chatId? }`.
  - Adds a user directly to the allowlist.
- `POST /api/connectors/telegram/remove`
  - Body: `{ userId }`.
  - Removes a user.
- `POST /api/connectors/telegram/policy`
  - Body: `{ dmPolicy: 'pairing' | 'allowlist' | 'disabled' }`.
- `POST /api/connectors/telegram/group`
  - Body: `{ groupId, requireMention?, allowFrom? }`.

### Wiring

Register the routes in `src/app.ts` after `registerChatEventRoutes(app)` and before `app.route('/', flue())`.

## Phase 4 — Outbound reply tool

### New file

- `src/tools/telegram-reply-tool.ts`

### Tool shape

```ts
export const telegramReplyTool = defineTool({
  name: 'telegram_reply',
  description: 'Reply to the Telegram conversation that triggered the current event. Use this when the orchestrator response should go back to Telegram.',
  parameters: Type.Object({
    eventId: Type.String(),
    text: Type.String(),
    replyTo: Type.Optional(Type.String()),
    format: Type.Optional(Type.String({ enum: ['text', 'markdownv2'] })),
  }),
  execute: async ({ eventId, text, replyTo, format }) => {
    const event = getTrustedEvent(eventId);
    if (event.connector !== 'telegram') {
      throw new Error('telegram_reply can only respond to Telegram events.');
    }
    const chatId = event.conversation.id;
    // chunk text to 4096, send files if any, respect format
    return 'sent';
  },
});
```

Critical security rule: the tool reads `chatId` from the **persisted event**, not from model-provided arguments. The model may choose the text, but trusted code chooses the destination.

### Attachments

- Accept optional `files: string[]` for absolute paths.
- Reuse `assertSendable()` logic from the reference implementation: refuse to send paths inside the state directory or other sensitive locations.
- `.jpg/.jpeg/.png/.gif/.webp` send as photos; everything else as documents.

## Phase 5 — Orchestrator integration

### File

- `src/agents/orchestrator.ts`

### Changes

1. Import `telegramReplyTool`.
2. Add it to the tools array: `tools: [loadProtocolsTool, retrieveMemoryTool, telegramReplyTool]`.
3. Update the `Runtime Capabilities` block to list `telegram_reply`.
4. Update instructions so the orchestrator knows to use `telegram_reply` for Telegram events instead of returning plain text.

### Initial prompt guidance

In `src/routes/chat-prompt.ts`, add a line:

```text
If this event came from the telegram connector and you want to respond, use the telegram_reply tool with eventId: "${event.id}".
```

This matches the existing pattern of reminding the orchestrator which tool owns the response path.

## Phase 6 — Tests

### New / updated tests

- `src/tests/telegram-connector.test.ts`

### What to test

- `normalizeTelegramUpdate()` still works.
- Access gate drops unknown senders under `pairing`/`allowlist`/`disabled`.
- Pairing code generation stores a pending row.
- `POST /api/connectors/telegram/pair` moves pending to allowed.
- Approved message creates a chat session with `surface: 'connector'` and `connector: 'telegram'`.
- Approved message reaches the orchestrator route.
- `telegram_reply` tool refuses non-Telegram events.
- `telegram_reply` sends to the trusted `conversation.id`.
- Long polling starts only when `TELEGRAM_BOT_TOKEN` and `connectors.telegram.enabled` are present.

## File inventory

### New files

- `src/connectors/telegram-ingress.ts`
- `src/connectors/telegram-api.ts` (thin fetch wrapper around Telegram Bot API)
- `src/routes/telegram-admin.ts`
- `src/tools/telegram-reply-tool.ts`
- `src/tests/telegram-connector.test.ts`

### Modified files

- `src/app.ts` — register admin routes; start ingress on boot.
- `src/config/gorombo-config.ts` — add Telegram config types.
- `src/config/gorombo.config.json` — add example config.
- `.env.example` — add env vars.
- `src/agents/orchestrator.ts` — attach `telegram_reply` tool and update instructions.
- `src/routes/chat-prompt.ts` — mention `telegram_reply` for Telegram events.
- `src/session/session-database.ts` — add Telegram access tables.
- `src/types/core.ts` — possibly add `TelegramDmPolicy`, `TelegramGroupPolicy` types.
- `src/index.ts` — export public types/helpers if needed.

## Dependencies

- Evaluate whether to add `grammy` as a dependency.
  - Pro: battle-tested polling, file download, mention parsing, chunking.
  - Con: another dependency.
- Alternative: raw `fetch` to `https://api.telegram.org/bot<token>/...` for both polling (`getUpdates`) and sending.
  - Pro: zero new runtime dependencies.
  - Con: more code for polling loop, file uploads, entity parsing.

Recommendation: start with raw `fetch` because GOROMBO Agent's dependency rule says "prefer existing dependencies" and the Bot API surface we need is small. If file handling or polling reliability becomes painful, switch to `grammy` in a later iteration.

## Operational notes

- Telegram only allows one active `getUpdates` consumer per bot token. Running two GOROMBO Agent processes with the same token will cause `409 Conflict`. The deployment model is one running `pnpm start` process per bot token.
- Set `NODE_OPTIONS=--dns-result-order=ipv4first` on the deployment environment to avoid silent IPv6 hangs to Telegram's API servers.
- BotFather group privacy must be disabled for group delivery, and the bot must be re-added after the change.

## First end-to-end slice

To get something working quickly:

1. Add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_APPROVED_USER_IDS` to `.env.example`.
2. Create `src/connectors/telegram-ingress.ts` that starts long-polling only when `TELEGRAM_BOT_TOKEN` is present.
3. Hard-gate DMs by `TELEGRAM_APPROVED_USER_IDS` (no pairing yet).
4. Normalize approved messages and call the durable orchestrator route synchronously.
5. Send the orchestrator response back to Telegram.
6. Add `telegram_reply` tool for asynchronous replies.

Pairing, groups, admin routes, and attachment handling follow in subsequent PRs.

## Verification before claiming done

Run the standard project checks:

```bash
pnpm run test:unit
pnpm run build
pnpm run test:http
```

For TypeScript-only connector code, add focused connector tests under `src/tests/` and run them as part of `test:unit`.
