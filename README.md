# flue-agent (SIM-ONE Alpha)

SIM-ONE Alpha is a Flue-based agent project for building practical AI Employees, business automation workflows, research assistants, coding workers, connected chat experiences, and operational AI systems.

It is built on [Flue](https://flueframework.com), a TypeScript agent harness framework from the Astro ecosystem.

SIM-ONE Alpha adds its own protocol system, memory layer, RAG architecture, registry-driven tools, registry-driven skills, registry-driven workers, Telegram/API connectors, and business workflow patterns on top of Flue.

The goal is simple:

> Build agents that can do useful work, retrieve the context they need, follow rules, use tools, and coordinate specialized workers without turning every task into one giant prompt.

## Features

- Flue-based TypeScript agent foundation
- Telegram and Web/API connector support
- Secure Web API / Gateway layer
- SQLite-backed protocol system
- Database-backed memory layer
- RAG architecture with memory, web search, and document-index support
- Registry-driven tools
- Registry-driven skills
- Registry-driven workers/subagents
- Runtime-extensible capability model
- Coding worker with plan / implement / test-debug / review / GitHub subagents and approval-gated repo mutations
- Business-focused AI Employee architecture
- Runpod Public Endpoints image generation tool (`generate_image`) attached directly to the main orchestrator

## Why Flue

SIM-ONE Alpha is built with Flue because Flue provides the programmable agent harness layer needed for real agent workflows.

Flue gives the project a foundation for:

- agents
- sessions
- tools
- skills
- workflows
- filesystem access
- sandboxed execution
- deployable runtimes

SIM-ONE Alpha builds on that foundation with:

- protocols
- memory
- retrieval
- registries
- connectors
- business workflows
- worker orchestration

Flue provides the harness.

SIM-ONE Alpha defines the operating system built on top of it.

## About Gorombo

SIM-ONE Alpha is built by [Gorombo](https://gorombo.com), a governance-first AI software company since 1999.

Gorombo's mission: better AI comes from better governance, not bigger models.

- Website: https://gorombo.com
- Founder/CEO: Daniel T Sasser II

## How It Works

Messages enter the system through Telegram, Web/API, scheduled jobs, or future connectors.

Those messages are normalized and passed into the agent system through the Secure Web API / Gateway.

The agent then loads applicable protocols, retrieves memory or outside context when needed, uses tools, delegates to workers when appropriate, validates the result, and returns a response.

Basic flow:

```text
Connector
-> Secure Web API / Gateway
-> Normalized Message Event
-> Agent
-> Protocol Tool
-> Memory / RAG
-> Tools / Workers
-> Validation
-> Response
```

## Core Systems

### Protocols

Protocols are runtime rules.

Protocols are not skills.

Protocols are stored in SQLite and loaded through a protocol tool.

The protocol system gives the agent applicable rules before it responds, uses tools, or delegates work.

Examples of protocol records may include:

- global rules
- connector rules
- client rules
- project rules
- workflow rules
- task rules
- output rules
- safety rules

### Memory

Memory is a first-class architecture layer. Protocols provide rules; memory provides context.

Structured memory is implemented as durable **checklists, todos, and session notes** that survive across long-running tasks and process restarts. The data model, scope matching, and query/scoring logic live in a Rust crate (`crates/gorombo-memory/`) compiled to WebAssembly via `wasm-pack`; a thin TypeScript shim (`src/memory/rust-memory-engine.ts`) loads the WASM module and delegates every create/update/delete/query to it. A pure-TypeScript `InMemoryMemoryEngine` mirrors the same contract as a parity reference for unit tests.

- **Durable store:** every mutation is persisted to SQLite (default `.gorombo/db/structured-memory.sqlite`); the WASM in-memory index is hydrated from the durable store on cold start via `reconcile_index`.
- **Scope is truth, never from the model:** scope (`actorId`/`conversationId`/`projectId`/`threadId`) is derived from a trusted persisted `NormalizedMessageEvent` (`eventId`) for orchestrator tools, and injected from the worker context for coding-worker tools. Update operations verify the target record's scope matches before mutating.
- **Retrieval:** surfaced through `retrieve_memory` alongside session memory and RAG, ranked and truncated to the context budget.

See [Memory Helper (Structured Memory)](#memory-helper-structured-memory) for the full architecture, configuration, and smoke commands.

### RAG

RAG gives the agent access to knowledge outside the current prompt.

The RAG architecture should support:

- memory retrieval
- web search
- company documents
- Git repositories
- project data
- client data
- future vector stores

RAG should be one of the first major systems built after basic chat routing works.

### Tools

Tools are executable capabilities.

A tool does something.

Examples:

- load protocols
- search memory
- query a database
- call an external API
- search documents
- search the web
- send a Telegram message
- retrieve project context
- create a draft
- run validation
- generate an image with Runpod Public Endpoints (`generate_image`)
- record image metadata (`record_image_artifact`)
- list prior image artifacts (`list_image_artifacts`)

Tools are discovered through the Tool Registry.

Native Flue tools can exist in the codebase, but runtime-extensible tools should be exposed through a registry wrapper or gateway.

### Skills

Skills are reusable workflow knowledge.

A skill describes how to perform a process.

Skills may reference tools.

Skills may guide the agent or workers.

Skills are not protocols and should not store mandatory runtime rules.

Future skills may include:

- research verification
- client update writing
- task decomposition
- PR synthesis
- SEO review
- construction workflow support
- code review

### Workers

Workers are specialized executors.

Workers may run independently or be called by the main agent.

Expected worker types include:

- Research Worker
- Writing Worker
- Coding Worker
- Testing / Review Worker
- Future Domain Workers

Workers should return structured results and should not silently mutate global state.

### Registries

Registries make the system extensible.

Core registries include:

- Tool Registry
- Skill Registry
- Agent / Worker Registry
- Protocol Access Layer

The registry system allows the project to support both base capabilities and user-defined capabilities without hardcoding every future tool, skill, or worker directly into the agent.

### Connectors

Connectors normalize external communication into internal message events.

Connectors do not contain orchestration logic.

Expected connector types include:

- Telegram
- Web/API
- Scheduled Jobs
- Future Connectors

Web chat is a client of the Secure Web API.

The Secure Web API is the backend ingress point.

## Example Workflows

### General Chat

```text
User
-> Connector
-> Gateway
-> Agent
-> Protocol Tool
-> Memory / RAG
-> Response
```

### Telegram Interaction

```text
Telegram
-> Telegram Connector
-> Normalized Message Event
-> Secure Web API / Gateway
-> Agent
-> Response
-> Telegram
```

### Research Task

```text
User Request
-> Agent
-> Protocol Tool
-> Memory Tool
-> RAG Router
-> Web Search / Docs / Repos
-> Research Worker if needed
-> Validated Answer
```

### Memory Retrieval Task

```text
User Request
-> Agent
-> Protocol Tool
-> Memory Tool
-> Memory DB / Document Index
-> Retrieved Context
-> Response
```

### Coding Task

```text
User Request
-> Agent
-> Protocol Tool
-> Coding Worker
-> Sandbox
-> Tests
-> Diff
-> Review
-> Response / Approval
```

### Business Automation Task

```text
User Request
-> Agent
-> Protocol Tool
-> Memory / RAG
-> Tool Registry
-> Business Tool
-> Validation
-> Response
```

## Technology Stack

Core stack:

```text
TypeScript
Flue
SQLite
Rust (WASM) — structured-memory engine
LanceDB — vector store
Node.js
```

Primary storage roles:

```text
SQLite      = protocol storage, Flue persistence, session state, structured memory
Rust/WASM   = structured-memory engine (checklists, todos, session notes)
LanceDB     = vector search (session memory, session notes, knowledge/project-file index)
```

## Project Structure


```text
src/
  agents/            # orchestrator + worker agent entrypoints
  workspace/         # main agent persona files
  connectors/        # telegram, web-api, scheduled-job normalizers
  routes/            # Hono HTTP routes (chat, approval, telemetry, schedules, ...)
  middleware/
  memory/            # structured-memory shim, SQLite store, providers (Rust/WASM engine lives in crates/)
  protocols/         # protocol system + SQLite protocol provider
  rag/                # retrieval, embeddings, vector store, indexers
  registries/        # tool / skill / agent registries
  skills/
  tools/             # orchestrator-owned tools (memory, research, ...)
  types/
  workers/           # coding worker + subagents + tools
  workflows/         # finite Flue operations (research, retrieval, web-research)
  tests/
crates/
  gorombo-memory/    # Rust structured-memory engine -> WASM (wasm-pack)
```

## Installation

This project is currently in early development.

Clone the repository:

```sh
git clone <repository-url>
cd <repository-name>
```

Install dependencies using the package manager used by the repo:

```sh
pnpm install
```

Run the development server or local workflow command defined in `package.json`:

```sh
pnpm run dev
```

Run tests:

```sh
pnpm test
```

Run type checks:

```sh
pnpm run typecheck
```

Build the project:

```sh
pnpm run build
```

Download the bundled local embedding model (required for local RAG out of the box):

```sh
pnpm fetch-embedding-model
```

After downloading the model, RAG works without Ollama running and without any API keys. The system tries the cloud provider first when `OLLAMA_API_KEY` is configured, and falls back to the bundled `all-MiniLM-L6-v2` ONNX model automatically.

Use the actual scripts defined in `package.json`.

Do not assume a command exists unless it is configured in the project.

## Local Chat

Model choice lives in the shipped runtime config file. In source it is:

```text
src/config/gorombo.config.json
```

After build it is copied to:

```text
dist/gorombo.config.json
```

```json
{
  "version": 1,
  "models": {
    "primary": "minimax-m3-cloud",
    "backup": "codex-brain"
  }
}
```

Create a local `.env` from `.env.example` and set provider secrets only:

```env
OLLAMA_API_KEY=your_ollama_cloud_key_here
CODEX_BRAIN_LOCAL_API_URL=http://192.168.0.131:4180/v1
CODEX_BRAIN_LOCAL_API_KEY=your_codex_brain_key_here
API_SECRET=local_testing_secret
RUNPOD_API_KEY=your_runpod_key_here
```

The default primary and backup model cards use Ollama's direct cloud API:

```env
OLLAMA_API_KEY=your_key_here
OLLAMA_CLOUD_BASE_URL=https://ollama.com/v1
GOROMBO_WEB_SEARCH_PROVIDER=ollama
OLLAMA_WEB_SEARCH_BASE_URL=https://ollama.com
GOROMBO_RAG_MAX_CONTEXT_TOKENS=4000
GOROMBO_RAG_WEB_FETCH_TOP_K=1
```

Embedding provider chain:

```text
cloud (Ollama Cloud, if OLLAMA_API_KEY is set)
  ↓ on any failure
onnx-local (bundled all-MiniLM-L6-v2, 384-dim, no network)
  ↓ on any failure
local (legacy Ollama local /v1/embeddings)
```

`OLLAMA_API_KEY` is optional. Without it, the bundled local model is used. If the local model files are missing, run `pnpm fetch-embedding-model`. Pre-AVX x86 CPUs and GPU execution providers are not supported by the default installer.

Select another project-owned model card by changing the shipped `gorombo.config.json` runtime file and restarting the runtime:

```json
{
  "version": 1,
  "models": {
    "primary": "qwen3-5-cloud",
    "backup": "deepseek-v4-pro-cloud"
  }
}
```

Register the DT1-hosted Codex Brain model through its own provider when needed:

```env
CODEX_BRAIN_LOCAL_API_URL=https://dt1.example.local/v1
CODEX_BRAIN_LOCAL_API_KEY=your_codex_brain_key_here
```

Then select it by card key in `gorombo.config.json`.

`CODEX_BRAIN_LOCAL_API_URL` must be the OpenAI-compatible base URL including `/v1`.

Run a one-shot research workflow:

```sh
pnpm run research:local -- "Find the official Ollama web search API docs URL."
```

Open an interactive Flue agent session:

```sh
pnpm run connect
```

Start the built Node HTTP runtime:

```sh
pnpm run build
pnpm start
```

The HTTP runtime uses the Flue routing model:

- `GET /health` is public.
- `POST /api/chat/events` is the app-owned chat ingress alias.
- `GET /api/chat/sessions` lists stored chat sessions for HTTP clients.
- `POST /agents/orchestrator/:sessionId` is the durable Flue orchestrator agent route used by the chat ingress.
- `GET /runs/:runId` reads persisted Flue run and event stream records.

Protected routes require:

```text
x-api-secret: <API_SECRET>
```

`API_SECRET` must be set in `.env` or by the deployment secret manager. If it is missing, protected endpoints fail closed with `503`.

The app-owned chat ingress normalizes and authorizes the message, persists trusted event context to SQLite, resolves the product session, and prompts the durable orchestrator agent instance at `/agents/orchestrator/:sessionId?wait=result`. A successful normal chat event returns the direct agent result with stream coordinates:

```json
{
  "result": {},
  "streamUrl": "http://127.0.0.1:3000/agents/orchestrator/<sessionId>",
  "offset": "0",
  "event": { "id": "web-..." },
  "session": { "id": "<sessionId>", "surface": "web", "created": true }
}
```

Flue workflow HTTP invocation remains available for other finite workflow calls. Workflow calls return `202` with a `runId`; clients then read `/runs/:runId` with the same secret header to retrieve the completed workflow result.

The `/api/chat/events` durable ingress:

- Normalizes the incoming message event.
- Persists trusted event context before agent admission.
- Resolves the product session.
- Handles pre-LLM slash commands that can be handled at ingress.
- Prompts the durable `orchestrator` Flue agent instance for that session.

Model selection rules:

- `models.primary` and `models.backup` are project model card keys.
- Raw Flue specifiers and `GOROMBO_MODEL` env selection are rejected.
- The default primary card is `minimax-m3-cloud`, which resolves through its card to `ollama-cloud/minimax-m3` and calls Ollama Cloud through `https://ollama.com/v1`.
- The durable orchestrator agent uses the configured primary card. The backup card remains configured metadata for paths that explicitly implement fallback behavior.
- Model cards live inside each provider directory under `src/models/providers/<provider>/cards`.
- The catalog in `src/models/catalog.ts` aggregates cards for model selection and budget lookup.

The agent currently has tool flow wired for protocol loading, session-memory retrieval, and RAG/context retrieval. The protocol and document-index providers remain typed placeholders; web search is live through Ollama Search when an Ollama API key is configured.

## Model Cards

Model cards are the project-owned source of truth for models the agent can intentionally use.

Runtime model choice is separate from card definition. The shipped `gorombo.config.json` runtime file chooses active card keys:

```json
{
  "version": 1,
  "models": {
    "primary": "minimax-m3-cloud",
    "backup": "codex-brain"
  }
}
```

`.env` stores provider credentials. It must not choose models.

Each card lives under its owning provider directory, for example `src/models/providers/ollama-cloud/cards/minimax-m3.ts`, and owns the details that are specific to one model:

- provider id and model id
- Flue model specifier
- roles and capabilities
- context window limits
- maximum output tokens
- advertised, guaranteed, and provider-reported limits when those differ
- source notes for where the metadata came from

Provider files live next to their cards in `src/models/providers/<provider>`. Providers describe transport: base URLs, API key environment variables, Flue `registerProvider(...)` calls, and per-provider model registration. When a provider has multiple model cards, those cards live in that provider's `cards/` subdirectory. This keeps provider setup out of agent files and lets the agent reference a card by specifier.

Cards exist because session management, compaction, and RAG all need model-specific token limits. MiniMax M3, DeepSeek V4 Pro, and Qwen 3.5 do not have the same usable context or output budgets. The context-budget layer reads the selected card instead of hardcoding token limits in the agent, durable ingress, or RAG router.

Current cards:

```text
minimax-m3-cloud       -> ollama-cloud/minimax-m3
deepseek-v4-pro-cloud  -> ollama-cloud/deepseek-v4-pro
qwen3-5-cloud          -> ollama-cloud/qwen3.5:397b
codex-brain            -> codex-brain/gpt-5.5
```

MiniMax M3 is intentionally recorded with multiple limits: MiniMax advertises up to 1M context with a guaranteed 512K minimum, while Ollama Cloud currently reports 524288 through both direct cloud metadata and the local `:cloud` path. Session budget code must treat those as separate facts.

## Session Budget And Compaction

The durable chat ingress and session layer use card-driven context budget metadata for explicit compaction, session-memory indexing, and future RAG allocation.

Implemented pieces:

- `resolveModelCard(...)` maps a Flue model specifier back to a project model card.
- `calculateContextBudget(...)` chooses the provider-safe context window, reserves output tokens, and calculates warning, compaction, and hard-stop thresholds.
- `evaluateCompaction(...)` returns `normal`, `warn`, `compact`, or `stop`.
- `src/db.ts` exports the Flue persistence adapter discovered by Flue at build time.
- `session-persistence.ts` wraps Flue's built-in SQLite adapter and indexes latest logical workflow sessions plus durable direct-agent instance sessions.
- `session-database.ts` stores chat session catalog records, active connector sessions, persisted normalized event context, and session-memory FTS chunks.
- `deriveSessionBudgetStateFromData(...)` estimates budget from the stored Flue conversation tree, including compaction entries.
- `chatSessionBudgetStore` remains as an in-process fallback when stored session data is not available.
- The `/compact` slash command opens the durable direct-agent session and calls Flue `session.compact()` without sending the command text to the model.

Flue's native automatic compaction remains enabled on the orchestrator agent with card-derived `reserveTokens` and `keepRecentTokens`. The SIM-ONE Alpha layer adds explicit command compaction, persisted context lookup, and budget telemetry for future RAG allocation.

Session memory is now indexed from stored Flue `SessionData` and retrieved through the memory tool. The future full SIM-ONE Alpha memory stack is separate from this session-memory layer. Web search/document chunks should be injected only after the budget layer reports remaining context capacity.

Runtime SQLite defaults:

```text
.gorombo/db/flue.sqlite      Flue sessions, durable submissions, event streams, and workflow run/registry records
.gorombo/db/sessions.sqlite  chat sessions, active sessions, logical session indexes, normalized event context, and session-memory FTS
```

Protected telemetry uses live in-memory Flue observer summaries when available and can fall back to persisted Flue run events after the in-memory summary is gone.

Slash commands are parsed before the prompt reaches the LLM:

- `/new` starts a new trusted connector/TUI session. GUI-managed web chat should use the client new-chat control instead, and generic Web API payloads cannot opt into connector-only behavior by spoofing a connector name.
- `/compact` calls Flue `session.compact()` for the resolved durable direct-agent session and returns command telemetry.

Architecture details live in `docs/architecture/session-context-budget.md`.

## Web Search And Research

Ollama Search is the default web-search provider for the researcher-owned web research path.

The provider uses the existing Ollama API key:

```env
GOROMBO_WEB_SEARCH_PROVIDER=ollama
OLLAMA_API_KEY=your_key_here
OLLAMA_WEB_SEARCH_BASE_URL=https://ollama.com
GOROMBO_RAG_MAX_CONTEXT_TOKENS=4000
GOROMBO_RAG_WEB_FETCH_TOP_K=1
GOROMBO_RESEARCH_MAX_QUERIES=3
GOROMBO_RESEARCH_MAX_FETCHES=2
GOROMBO_RESEARCH_CACHE_DB=.gorombo/db/research-cache.sqlite
```

Implemented endpoints:

```text
POST https://ollama.com/api/web_search
POST https://ollama.com/api/web_fetch
```

`web_search` results are normalized into the project `RetrievedContext` shape with `provider: "web-search"` and `metadata.provider: "ollama"`. If no Ollama key is configured, the web provider falls back to the web-search placeholder instead of failing startup.

The researcher-facing `web_research` tool calls the `web-research` Flue workflow boundary, which owns query planning, search/fetch budget, cache use, evidence packing, confidence, and provider failures. The low-level `retrieve_context` tool remains researcher-only and must not be attached to the orchestrator.

The researcher-owned web research path handles:

- query planning: one search for simple lookups, multiple searches for complex research/comparison prompts
- cache: per-run in-memory cache plus optional SQLite persistent cache
- search-to-fetch enrichment: `webFetch: "auto"` or `"always"` fetches top pages when the provider supports `fetchPage(...)`
- context packing: returned contexts are packed to `maxContextTokens`, defaulting to `GOROMBO_RAG_MAX_CONTEXT_TOKENS` or `4000`
- provider failures: web-search failures are returned in `providerFailures` instead of failing the whole chat path

The `web_research` tool accepts optional `limit`, `maxContextTokens`, `webFetch`, `maxQueries`, `maxFetches`, and `freshness` controls.

Future RAG providers such as local SearXNG, GitHub, company documents, and durable memory should plug into the same `RagProvider` interface and then be ranked by the retrieval workflow and RAG router.

## Research Subagent

The main orchestrator has a registered Flue subagent named `researcher`.

Use the boundaries this way:

- no web needed: main orchestrator may answer, use protocols, or use safe memory lookup
- any web/current/source-backed information: main orchestrator delegates through Flue `task` with `agent: "researcher"`
- low-level provider errors: the research workflow records failures in `providerFailures`
- research strategy: researcher decides which searches to run, when to fetch pages, when to stop, and how to compare sources

The researcher subagent lives in `src/workers/researcher/researcher.ts` and owns the `web_research` tool. The standalone `research` workflow in `src/workflows/research.ts` initializes the researcher directly for CLI or API research runs. Use `pnpm run research:local -- "..."` for local one-shot research testing.

Main-agent workspace persona files live in `src/workspace/`. Subagent workspace persona files live beside their subagent implementation, for example `src/workers/researcher/workspace/`. Persona names belong inside workspace file contents, not in architecture paths.

```text
durable chat ingress
-> orchestrator agent
-> task tool with agent: "researcher"
-> researcher subagent
-> web_research
-> web-research workflow
-> retrieval workflow
-> cache / Ollama Search / future RAG providers
```

## Configuration

Environment variables are used for secrets and service configuration.

The main agent runtime config is a real JSON file shipped with the product:

```text
src/config/gorombo.config.json -> source
dist/gorombo.config.json       -> built/package runtime file
```

It starts with model selection and is intended to grow into the deployment-level config for the agent:

```json
{
  "version": 1,
  "models": { "primary": "minimax-m3-cloud", "backup": "codex-brain" },
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
  }
}
```

`storage` selects the Flue persistence and session SQLite paths. `memory` configures the structured-memory engine (see [Memory Helper](#memory-helper-structured-memory)). Any `memory` field can be overridden by a `GOROMBO_MEMORY_*` environment variable (`GOROMBO_MEMORY_BACKEND`, `GOROMBO_MEMORY_SQLITE_PATH`, `GOROMBO_MEMORY_RETENTION_DAYS`, `GOROMBO_MEMORY_ARCHIVE_DELETE_DAYS`, `GOROMBO_MEMORY_MAX_CHECKLIST_DEPTH`, `GOROMBO_MEMORY_DEFAULT_LIMIT`, `GOROMBO_MEMORY_MAX_CONTEXT_TOKENS`); env wins over JSON.

Change model choices in the shipped runtime JSON file, then restart the runtime/gateway. Keep API keys and service credentials in `.env` or the deployment secret manager.

For Node distribution, `.env` lives beside `package.json` at the runtime root. `pnpm start` runs:

```sh
node --env-file=.env dist/server.mjs
```

This loads provider keys, `API_SECRET`, and service settings before the built server starts.

Expected future environment values may include:

```text
OPENAI_API_KEY
ANTHROPIC_API_KEY
OLLAMA_API_KEY
OLLAMA_CLOUD_API_KEY
OLLAMA_CLOUD_BASE_URL
OLLAMA_LOCAL_BASE_URL
OLLAMA_LOCAL_API_KEY
CODEX_BRAIN_LOCAL_API_URL
CODEX_BRAIN_LOCAL_API_KEY
TELEGRAM_BOT_TOKEN
API_SECRET
TAVILY_API_KEY
BRAVE_SEARCH_API_KEY
```

`GOROMBO_MODEL`, `GOROMBO_MODEL_BACKUP`, and `GOROMBO_CONFIG_PATH` are not supported. Model choices must be card keys in the shipped `gorombo.config.json` runtime file.

Do not commit real secrets.

Use local `.env` files or the deployment platform's secret manager.

## Development

This project is being built incrementally.

Early development focuses on:

- base agent setup
- message normalization
- Secure Web API / Gateway skeleton
- Telegram connector
- SQLite protocol schema
- Protocol Tool
- Memory Tool
- RAG Router
- document-index retrieval placeholder
- Ollama web search provider
- registry interfaces
- worker interfaces

Use small, testable steps.

Do not build the entire final system in one pass.

## Memory Helper (Structured Memory)

The Memory Helper is the agent's durable memory: **checklists, todos, and session notes** that survive across long-running tasks and process restarts. It is built as a Rust crate compiled to WebAssembly, with SQLite as the durable backing store.

### How it works

```text
model tools (orchestrator / coding-worker)
  -> TypeScript shim  (src/memory/rust-memory-engine.ts)
  -> Rust engine       (crates/gorombo-memory/ -> WASM via wasm-pack)
       - data model: Checklist / ChecklistItem / Todo / SessionNote
       - scope matching + tag/keyword scoring + cycle/depth validation
  -> PersistingMemoryEngine decorator
       - every create/update/delete is written to SQLite
       - on cold start the WASM index is hydrated from SQLite via reconcile_index
  -> retrieve_memory (structured-memory provider) -> context budget -> model
```

- **Engine:** the data model, scope matching, and query scoring live in Rust (`crates/gorombo-memory/`), compiled to WASM with `wasm-pack`. A thin TypeScript shim (`src/memory/rust-memory-engine.ts`) loads the WASM module and delegates every mutation and query to it. A pure-TypeScript `InMemoryMemoryEngine` mirrors the same contract as a parity reference for unit tests.
- **Durable store:** a `PersistingMemoryEngine` decorator wraps the engine so every create/update/delete is persisted to SQLite (default `.gorombo/db/structured-memory.sqlite`). The WASM in-memory index is hydrated from the durable store on cold start via `reconcile_index`, so records survive process restarts.
- **Data model:**
  - **Checklist** — a scoped list with nested `ChecklistItem`s (parentId tree, ordinal ordering, status, tags, due dates).
  - **Todo** — a scoped task with priority, status, due date, tags.
  - **SessionNote** — a pinned decision/reminder with importance and optional LanceDB semantic search.
- **Scope is truth, never from the model.** Scope derivation differs by tool family:
  - **Orchestrator tools** (`create_checklist`, `create_todo`, `store_session_note`, and their update/list counterparts) derive all scope fields (`actorId`/`conversationId`/`projectId`/`threadId`) from a trusted persisted `NormalizedMessageEvent` (`eventId`); the model cannot supply scope, and update operations verify the target record's scope matches the trusted event scope before mutating.
  - **Coding-worker tools** (`coding_task_*`) inject `projectId` from the trusted worker context (`CodingWorkspaceTargetInput` — `projectId`/`projectSlug`/`projectRelativePath`/`repoPath`), not from a chat event; `taskId` is the trust anchor. They fail closed at execution time if no trusted project scope is available.
- **Retrieval** is surfaced through `retrieve_memory` (default providers include `structured-memory`) alongside session memory, ranked and truncated to the context budget. Session notes are optionally searchable by LanceDB semantic similarity (merged with the keyword index via reciprocal rank fusion), with a graceful keyword-only fallback when no embedding client is configured.
- **Coding worker** tools (`coding_task_*`) route every mutating write through `SharedCodingApprovalService` as an audit-only `memory.write` event (never blocking). The `coding_task_handoff_plan_to_checklist` tool copies a finished task run's plan into a durable checklist for cross-run continuity.

### Build and smoke

Build the WASM artifact and run the Memory Helper smoke:

```sh
pnpm run wasm:build
pnpm run smoke:memory
```

The default smoke drives the real Memory Helper tools, WASM engine, SQLite, `retrieve_memory`, and the coding-worker path end-to-end with a durability restart check (no live model required). To run the real-model smoke that boots the server and lets a live model drive the orchestrator memory tools, set `GOROMBO_SMOKE_REAL_MODEL=1` (requires a `.env` with model API creds and a built `dist`): `GOROMBO_SMOKE_REAL_MODEL=1 pnpm run smoke:memory`.

### Configuration

The `memory` block of `gorombo.config.json` configures the engine:

```json
{
  "memory": {
    "enabled": true,
    "backend": "sqlite",
    "defaultLimit": 10,
    "maxContextTokens": 1500,
    "enableSemanticNotes": true,
    "retentionDays": 30,
    "archiveDeleteDays": 365,
    "maxChecklistDepth": 5
  }
}
```

Any field can be overridden by a `GOROMBO_MEMORY_*` environment variable (`GOROMBO_MEMORY_BACKEND`, `GOROMBO_MEMORY_SQLITE_PATH`, `GOROMBO_MEMORY_RETENTION_DAYS`, `GOROMBO_MEMORY_ARCHIVE_DELETE_DAYS`, `GOROMBO_MEMORY_MAX_CHECKLIST_DEPTH`, `GOROMBO_MEMORY_DEFAULT_LIMIT`, `GOROMBO_MEMORY_MAX_CONTEXT_TOKENS`); env wins over JSON.


## Testing

Run relevant verification before calling work complete.

Common commands:

```sh
pnpm test
pnpm run typecheck
pnpm run build
pnpm run test:http
pnpm run smoke:http
pnpm run wasm:build        # build the gorombo-memory WASM artifact
pnpm run cargo:test        # cargo test -p gorombo-memory (Rust crate tests)
pnpm run smoke:memory      # Memory Helper end-to-end + durability smoke
```

`pnpm test` runs the TypeScript unit suite, builds `dist/server.mjs`, then runs `pnpm run test:http` against the built server over real localhost HTTP. The root `.env` file remains the runtime environment source; it is not copied into `dist`.

For a live built-server chat smoke through `/api/chat/events`, run:

```sh
pnpm run smoke:http -- --live-chat
```

If the project defines other scripts in `package.json`, use those exact scripts.

Do not claim tests passed unless they were actually run.

## Public Development Status

This repository is public during early development to help the community learn from and contribute to the project.

The project may become private later as proprietary business logic, client-specific workflows, and production infrastructure are added.

## Contributing

Contributions are welcome during the public development phase.

Contribution guidelines are still being finalized.

Placeholder for expanded contribution guidelines:

```text
TBD: branch naming, issue labels, pull request process, coding standards, review rules, and community expectations.
```

## Code of Conduct

A project code of conduct will be added as the community grows.

Placeholder for future Code of Conduct:

```text
TBD: community standards, reporting process, and enforcement guidelines.
```

## Security

Do not open issues containing secrets, tokens, API keys, private customer data, or confidential business information.

Security policy placeholder:

```text
TBD: responsible disclosure process and security contact.
```

## License

License placeholder:

```text
TBD: license selection.
```

## Attribution

SIM-ONE Alpha is built by [Gorombo](https://gorombo.com) with [Flue](https://flueframework.com), the TypeScript agent harness framework from the Astro ecosystem.

Flue provides the underlying agent harness.

SIM-ONE Alpha adds protocol, memory, registry, connector, retrieval, worker, and business workflow layers on top of Flue.

## Guiding Principle

SIM-ONE Alpha is not built around one giant prompt.

It is built around an agent that can coordinate rules, memory, retrieval, tools, skills, workers, registries, and connectors.

```text
Protocols provide rules.

Memory provides context.

RAG provides knowledge.

Tools provide actions.

Workers provide specialized execution.

The agent coordinates the system.

```
