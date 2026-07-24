# HTTP API Reference

The Secure Web API is the ingress and operations surface for external clients,
the terminal interface, connectors, schedules, approvals, and telemetry.

## Base URL

The default local gateway URL is:

```text
http://127.0.0.1:3940
```

The configured gateway port can be changed in
`gorombo.config.json`.

## Authentication

Non-loopback clients send:

```http
x-api-secret: <API_SECRET>
```

Loopback requests without forwarding headers bypass the external API secret so
the local terminal client can connect. Requests containing `Forwarded`,
`X-Forwarded-For`, or `X-Real-IP` are treated as external even when they reach
the local socket.

Protected requests fail with:

- `401` when the supplied secret is wrong;
- `503` when an external request reaches a gateway without `API_SECRET`
  configured.

## Health

### `GET /health`

Returns:

```json
{
  "ok": true
}
```

## Chat

### `POST /api/chat/events`

Submits a normalized Web API or terminal message.

```json
{
  "connector": "web-api",
  "text": "Summarize the latest project status.",
  "actorId": "user-123",
  "actorDisplayName": "User",
  "conversationId": "conversation-456",
  "threadId": "thread-789",
  "clientId": "client",
  "projectId": "project"
}
```

The generic endpoint accepts only `web-api` and `tui` connector identities.
Other values normalize to `web-api`; public callers cannot claim a trusted
connector identity through JSON.

### `POST /api/chat/sessions`

Creates a fresh terminal session.

```json
{
  "connector": "tui",
  "actorId": "local-tui",
  "conversationId": "local-tui"
}
```

### `POST /api/chat/sessions/:sessionId/resume`

Validates ownership and resumes an exact session id or explicit name. A missing
owned selector creates a fresh session; forbidden or ambiguous selectors fail.

### `GET /api/chat/sessions`

Lists sessions. Supplying `connector`, `actorId`, and `conversationId` scopes
the result to an owned terminal identity.

Query parameters:

```text
connector=tui
actorId=<actor>
conversationId=<conversation>
threadId=<optional-thread>
limit=1..100
```

### `GET /api/chat/sessions/:sessionId/transcript`

Returns a scoped, paginated transcript.

Query parameters:

```text
connector=tui
actorId=<actor>
conversationId=<conversation>
threadId=<optional-thread>
limit=1..100
before=<opaque-cursor>
```

## Knowledge

### `POST /api/knowledge`

```json
{
  "title": "Deployment policy",
  "content": "Production changes require approval.",
  "tags": ["operations", "policy"],
  "actorId": "operator",
  "conversationId": "default"
}
```

`title` and `content` are required.

### `POST /api/knowledge/reindex`

Starts background indexing and returns `202`.

## Schedules

All schedule routes are protected by the API secret middleware.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/schedules` | List schedules |
| `POST` | `/api/schedules` | Create a schedule |
| `GET` | `/api/schedules/:slug` | Get one schedule |
| `PATCH` | `/api/schedules/:slug` | Update schedule fields |
| `DELETE` | `/api/schedules/:slug` | Delete a schedule and stop its timer |
| `POST` | `/api/schedules/:slug/pause` | Pause a schedule |
| `POST` | `/api/schedules/:slug/resume` | Resume a schedule |
| `POST` | `/api/schedules/:slug/run` | Run now |
| `GET` | `/api/schedules/:slug/runs` | List run history |
| `GET` | `/api/schedules/:slug/runs/:runId` | Get one run |

`POST /api/schedules/:slug/run?wait=1` waits up to the bounded request deadline
for a terminal run state.

## Approvals

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/approvals/pending` | List pending approvals |
| `GET` | `/api/approvals/:requestId` | Read one approval |
| `POST` | `/api/approvals/:requestId/decision` | Approve or reject a request |
| `GET` | `/api/approvals/bindings/pending` | List pending connector bindings |

Approval decisions require `decidedBy`, an `approved` boolean, and an optional
reason. The approval service validates that the request is still pending.

## Telegram Administration

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/connectors/telegram/status` | Read policy, users, pairings, and groups |
| `GET` | `/api/connectors/telegram/health` | Read connector runtime health |
| `POST` | `/api/connectors/telegram/pair` | Approve a pairing code |
| `POST` | `/api/connectors/telegram/deny` | Deny a pairing code |
| `POST` | `/api/connectors/telegram/allow` | Add an allowed user |
| `POST` | `/api/connectors/telegram/remove` | Remove an allowed user |
| `POST` | `/api/connectors/telegram/policy` | Set `pairing`, `allowlist`, or `disabled` |
| `GET` | `/api/connectors/telegram/groups` | List configured groups |
| `POST` | `/api/connectors/telegram/group` | Configure a group |
| `DELETE` | `/api/connectors/telegram/group/:groupId` | Remove a group |

## Telemetry

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/telemetry/runs` | List sanitized run summaries |
| `GET` | `/api/telemetry/runs/:runId` | Read one run summary |

Telemetry responses expose structured execution evidence without returning
secret values.

## Flue Routes

The gateway also mounts Flue agent, workflow, and run routes:

```text
/agents/*
/workflows/*
/runs/*
```

These routes require the external API secret outside loopback. Use the
[Flue SDK documentation](https://flueframework.com/docs/sdk/overview/) for the
Flue transport and streaming contracts.

## Error Handling

Clients should handle:

| Status | Meaning |
| --- | --- |
| `400` | Invalid JSON, fields, selector, cursor, or command |
| `401` | Invalid API secret |
| `403` | Valid identity without access to the requested session or resource |
| `404` | Resource not found |
| `409` | Ambiguous selector or non-pending state transition |
| `500` | Runtime or persistence failure |
| `503` | Required service or external authentication is not configured |

Do not infer successful work from request acceptance alone. Schedule dispatch,
agent execution, and workflows can continue asynchronously; use the returned
run, session, transcript, or telemetry identifiers to verify completion.
