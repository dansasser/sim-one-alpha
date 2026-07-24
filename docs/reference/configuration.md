# Configuration Reference

SIM-ONE Alpha separates non-secret runtime configuration from credentials and
service secrets.

## Configuration Files

| File | Purpose |
| --- | --- |
| `~/.gorombo/sim-one-alpha/gorombo.config.json` | Models, storage, memory, schedules, gateway settings, and seeded capabilities |
| `~/.gorombo/.env` | Provider keys, connector tokens, service credentials, and deployment overrides |

Keep secrets out of `gorombo.config.json`. Do not commit `.env` or copy secret
values into an agent workspace, issue, or chat transcript.

## Product Commands

Read and update normal configuration through the product CLI:

```bash
sim-one config get <key>
sim-one config set <key> <value>
sim-one restart
sim-one doctor
```

The gateway loads configuration at startup. Restart after changing files,
secrets, models, or runtime capabilities.

## Configuration Shape

The runtime configuration declares schema version `1`.

```json
{
  "version": 1,
  "models": {
    "primary": "minimax-m3-cloud",
    "backup": "codex-brain"
  },
  "storage": {
    "flueDatabasePath": ".gorombo/db/flue.sqlite",
    "sessionDatabasePath": ".gorombo/db/sessions.sqlite"
  },
  "memory": {
    "enabled": true,
    "backend": "sqlite",
    "defaultLimit": 10,
    "maxContextTokens": 1500,
    "enableSemanticNotes": true,
    "retentionDays": 30,
    "archiveDeleteDays": 365,
    "maxChecklistDepth": 5
  },
  "gateway": {
    "mode": "service",
    "port": 3940
  },
  "capabilities": []
}
```

Unknown application-owned blocks can be preserved, but the runtime validates
the required version and model selection plus typed storage, gateway, and
capability fields.

## Models

`models.primary` is required. `models.backup` is optional and must select a
different model card.

| Model card | Required credentials |
| --- | --- |
| `minimax-m3-cloud` | `OLLAMA_API_KEY` or `OLLAMA_CLOUD_API_KEY` |
| `deepseek-v4-pro-cloud` | `OLLAMA_API_KEY` or `OLLAMA_CLOUD_API_KEY` |
| `qwen3-5-cloud` | `OLLAMA_API_KEY` or `OLLAMA_CLOUD_API_KEY` |
| `kimi-k2.7-code-cloud` | `OLLAMA_API_KEY` or `OLLAMA_CLOUD_API_KEY` |
| `codex-brain` | `CODEX_BRAIN_LOCAL_API_URL` and `CODEX_BRAIN_LOCAL_API_KEY` |

Ollama Cloud defaults to `https://ollama.com/v1`.
`CODEX_BRAIN_LOCAL_API_URL` must include the OpenAI-compatible `/v1` base path.

Model cards own provider identifiers, context limits, output limits, and
credential names. Provider secrets do not belong in model cards.

Startup fails closed for an unknown card, duplicate primary and backup cards,
or missing credentials for a selected model.

## Gateway

```json
{
  "gateway": {
    "mode": "service",
    "port": 3940
  }
}
```

Supported modes are `dev`, `terminal`, and `service`. The port must be an
integer from 1 to 65535.

Set `API_SECRET` for non-loopback gateway clients. Local terminal requests from
the loopback interface do not require the header. Requests carrying forwarding
headers are treated as external.

## Storage

```json
{
  "storage": {
    "flueDatabasePath": ".gorombo/db/flue.sqlite",
    "sessionDatabasePath": ".gorombo/db/sessions.sqlite",
    "vectorStorePath": ".gorombo/vector"
  }
}
```

| Data | Default location |
| --- | --- |
| Flue runtime state | `~/.gorombo/db/flue.sqlite` |
| Connector and logical session data | `~/.gorombo/db/sessions.sqlite` |
| Structured memory | `~/.gorombo/db/structured-memory.sqlite` |
| Protocols | `~/.gorombo/db/protocols.sqlite` |
| Runtime capabilities | `~/.gorombo/db/capabilities.sqlite` |
| Schedules and run history | `~/.gorombo/db/schedules.sqlite` |
| Semantic retrieval data | `~/.gorombo/vector/` |

These files are runtime-managed. Back them up as a unit and do not edit SQLite
records directly.

## Structured Memory

The memory block controls durable checklists, todos, session notes, retention,
and retrieval limits.

| Field | Purpose |
| --- | --- |
| `enabled` | Enables structured memory |
| `backend` | Durable backend; `sqlite` is the product default |
| `defaultLimit` | Default number of retrieved records |
| `maxContextTokens` | Maximum structured-memory context returned to the agent |
| `enableSemanticNotes` | Enables semantic note retrieval |
| `retentionDays` | Active-record retention period |
| `archiveDeleteDays` | Archived-record deletion horizon |
| `maxChecklistDepth` | Maximum checklist nesting depth |

Deployment overrides use `GOROMBO_MEMORY_*`, including:

```text
GOROMBO_MEMORY_BACKEND
GOROMBO_MEMORY_SQLITE_PATH
GOROMBO_MEMORY_DEFAULT_LIMIT
GOROMBO_MEMORY_MAX_CONTEXT_TOKENS
GOROMBO_MEMORY_RETENTION_DAYS
GOROMBO_MEMORY_ARCHIVE_DELETE_DAYS
GOROMBO_MEMORY_MAX_CHECKLIST_DEPTH
```

## Providers And Services

### Web Research

Web research uses the configured Ollama key by default.

```text
GOROMBO_WEB_SEARCH_PROVIDER
OLLAMA_WEB_SEARCH_BASE_URL
OLLAMA_WEB_SEARCH_TIMEOUT_MS
GOROMBO_RAG_MAX_CONTEXT_TOKENS
GOROMBO_RAG_WEB_FETCH_TOP_K
```

### Embeddings And Retrieval

The embedding chain uses cloud embeddings when configured, then the bundled
local ONNX model, then an optional local Ollama endpoint.

```text
OLLAMA_CLOUD_EMBEDDING_MODEL
OLLAMA_LOCAL_BASE_URL
OLLAMA_LOCAL_API_KEY
OLLAMA_LOCAL_EMBEDDING_MODEL
GOROMBO_EMBEDDING_MODEL_PATH
GOROMBO_EMBEDDING_TIMEOUT_MS
GOROMBO_VECTOR_STORE_PATH
```

### Image Generation

```text
RUNPOD_API_KEY
RUNPOD_API_BASE_URL
RUNPOD_IMAGE_MODELS_PATH
GOROMBO_IMAGE_OUTPUT_DIR
```

### Telegram

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_WEBHOOK_SECRET_TOKEN
TELEGRAM_DM_POLICY
TELEGRAM_ADMIN_USER_IDS
TELEGRAM_APPROVED_USER_IDS
TELEGRAM_BOT_USERNAME
TELEGRAM_MENTION_PATTERNS
```

See [Connectors And Pairing](../guides/connectors.md).

## Approvals And Managed Authentication

```text
GOROMBO_APPROVAL_ROOT
GOROMBO_GITHUB_AUTH_ROOT
```

Approval and managed-auth roots must remain outside Coding Worker project
workspaces. The default managed GitHub profile is stored under
`~/.gorombo/auth/github/`.

## Runtime Capabilities

Runtime capabilities can be seeded in `gorombo.config.json`, but the SQLite
capability registry becomes authoritative after installation.

Each capability record includes:

```text
id
kind
name
description
source
sourceRef
version
enabled
config
```

Valid kinds are `skill`, `tool`, `worker`, and `mcp`. Use the product CLI for
normal capability management rather than editing the configuration array.

## Validation

After changes:

```bash
sim-one restart
sim-one doctor
```

See [Troubleshooting](../operations/troubleshooting.md) when configuration or
credential validation fails.
