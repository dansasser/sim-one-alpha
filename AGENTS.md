# AGENTS.md

## Project Overview

This repository contains the SIM-ONE Alpha multi-purpose orchestrating agent.
Never edit the main branch.
Always create a new branch for your work, and open a pull request when ready.

The system is built with Flue. A Typescript-based agent framework built by the Astro team.

The main orchestrating agent receives messages from connectors, loads applicable protocols from SQLite, retrieves context when needed, uses tools, delegates work to workers/subagents, validates results, and returns a response.

The orchestrator is a coordinator, not a hardcoded knowledge base.

## Product Identity

```text
Gorombo       = the company
SIM-ONE Alpha = the product / AI employee system built in this repository
Flue          = the TypeScript agent harness framework from the Astro team
Ollie         = the main agent persona (defined in src/workspace contents, not paths)
```

Keep company, product, framework, agent, worker, workspace, and repository names distinct. Do not use "Gorombo" as the default product name. This repository is `sim-one-alpha`; the runtime product is SIM-ONE Alpha.

Workers are subsystems of SIM-ONE Alpha, not standalone products or public endpoints.

## Naming Conventions

### Product CLI binary

- The product binary is `sim-one` (lowercase, hyphenated).
- Hyphens in CLI binary names are safe for shell commands, global npm install, and subcommands (`sim-one skill add ...`).
- When deriving environment variable prefixes from the product name, use underscores: `SIM_ONE_API_KEY`, `SIM_ONE_CONFIG_PATH`, etc. Hyphens are invalid in env var names.

### File and directory naming

- **Runtime data root:** `~/.gorombo/` — uses the company name (Gorombo). This is intentional and matches industry convention (other companies name their runtime dirs after the company, not the product).
- **SQLite databases:** `.gorombo/db/*.sqlite` — e.g. `capabilities.sqlite`, `protocols.sqlite`, `sessions.sqlite`.
- **Capability directories:** `.gorombo/capabilities/{skills,tools,workers,mcp}/<id>/`.
- **Config file:** `gorombo.config.json` — company-prefixed, shipped in `dist/`.
- **Environment variables:** `GOROMBO_*` prefix for runtime config (e.g. `GOROMBO_CAPABILITY_DB_PATH`, `GOROMBO_CAPABILITIES_DIR`, `GOROMBO_APPROVAL_ROOT`). Use `SIM_ONE_*` prefix for product-CLI-specific env vars if needed in the future.
- **Source code:** `src/` directories use lowercase kebab-case (`src/capabilities/`, `src/rag/`). TypeScript files use kebab-case (`capability-store.ts`, `mcp-broker.ts`).
- **Scripts:** `scripts/` uses kebab-case (`capability-admin.mjs`, `protocol-admin.mjs`, `build-prod.mjs`).
- **Docs:** `docs/architecture/` uses kebab-case (`capability-system.md`, `product-flow.md`).

### What NOT to name things

- Do not prefix product-facing names with "Gorombo" — the product is SIM-ONE Alpha, not Gorombo Alpha.
- Do not use "Ollie" in file paths or architecture names — persona names belong inside workspace file contents, not in paths.
- Do not use camelCase or PascalCase for files or directories — use kebab-case consistently.
- Do not create env vars with hyphens — use underscores.


## Flue Architecture Contract

Before modifying agents, workflows, tools, skills, subagents, model cards, provider runtime, routing, memory, RAG, or `src/app.ts`, read:

```text
docs/architecture/flue-architecture.md
docs/architecture/gorombo-flue-map.md
```

Do not rediscover basic Flue architecture from web search when these docs are present. Treat them as the repo source of truth unless the user explicitly asks to refresh them from upstream Flue docs.

In this project:

```text
src/app.ts
  Hono routes, middleware, health checks, custom ingress, and app.route('/', flue()) only.
  No orchestration logic.
  No direct RAG or web-search wiring.
  No direct old/non-Flue orchestrator path.
  No passing process.env into model-provider setup.

src/agents/orchestrator.ts
  Main Flue createAgent(...) entrypoint.
  The main agent selects models from project model cards.
  The main agent attaches tools, skills, subagents, sessions, and compaction.

src/workspace/
  Main agent user-editable workspace persona files.
  Persona names belong inside workspace file contents, not in architecture paths.

src/workers/<name>/*.ts
  Worker implementations for Flue subagent profiles.
  Workers are built like normal agents but are organized away from main agent entrypoints.

src/workers/<name>/workspace/
  Worker user-editable workspace persona files.

src/workflows/*.ts
  Finite Flue operations.
  Workflows can initialize agents, open sessions, call tasks/skills, and implement bounded application machinery.

src/tools/*.ts
  Executable model-callable capabilities exposed only to the agents that should own them.

src/skills/**/SKILL.md
  Reusable workflow knowledge and instructions, not executable capability.

model cards
  Model id, provider id, specifier, capabilities, context limits, and environment variable names.
  No secrets.

provider runtime
  Resolves card-declared environment variable names and registers Flue providers.
```

The orchestrator agent routes and delegates. It should not do substantive work directly. Orchestrator-owned tools should support orchestration, such as protocol loading and safe memory lookup.

The researcher subagent owns web research. The orchestrator may decide web/current/source-backed information is needed, but it must delegate that work to the researcher. The orchestrator must not directly call web search or a web-capable retrieval path.

## Core Runtime Flow

```text
Connector
-> Secure Web API / Gateway
-> Normalized Message Event
-> Orchestrator
-> Protocol Tool
-> SQLite Protocol Database
-> Applicable Protocol Bundle
-> Orchestrator
-> Tools / RAG / Memory / Workers
-> Validation
-> Response
```

## Technology Stack

Use:

```text
TypeScript
Flue
SQLite
mongoDB (for memory, optional)
Node runtime
```

Flue is the agent framework for this project.

SQLite and mongoDB are for memory and the protocol storage layers.

## Orchestrator

The orchestrator is responsible for:

```text
intent detection
protocol loading
planning
retrieval
tool selection
worker delegation
validation
response synthesis
```

The orchestrator must call the Protocol Tool on every orchestration call before final reasoning, tool execution, worker delegation, or response generation.

## Protocol System

Protocols are not skills.

Protocols are stored in SQLite.

Protocols are runtime rule records.

Protocols are loaded through the Protocol Tool.

The Protocol Tool queries SQLite and returns the applicable protocol bundle for the current call.

Protocol lookup may use:

```text
connector
user
client
project
task
workflow
message type
priority
enabled status
```

Protocol flow:

```text
Orchestrator
-> Protocol Tool
-> SQLite Protocol Database
-> Applicable Protocol Bundle
-> Orchestrator
```

Protocols may include:

```text
global rules
connector rules
client rules
project rules
workflow rules
task rules
output rules
safety rules
```

Protocols are applied through tools.

Protocols are never implemented as skills.

## Tool System

Tools are executable capabilities.

Tools are discovered through the Tool Registry.

The Tool Registry is the authoritative source of available tool definitions.

Tool flow:

```text
Orchestrator
-> Tool Registry
-> Tool
-> Result
-> Orchestrator
```

Native Flue tools may exist in the codebase.

Runtime-extensible tools should be exposed through a registry wrapper or gateway instead of being hardcoded into orchestrator logic.

## Skill System

Skills are reusable workflow knowledge.

Skills describe how to perform a process.

Skills may reference tools.

Skills may instruct the orchestrator or workers.

Skills are not protocols.

Skills do not store mandatory runtime rules.

## Worker / Subagent System

Workers are specialized executors. They are subsystems of SIM-ONE Alpha, not standalone products or public endpoints.

Workers live under `src/workers/<name>/`. They are built like normal Flue agents but are organized away from the main agent entrypoint.

All workers are invoked by the main orchestrator. The orchestrator workspace at `src/workspace/` defines when and how to invoke each worker. A worker's own workspace at `src/workers/<name>/workspace/` defines the worker's internal persona and guidance, not the orchestrator's routing rules.

Workers are discovered through the Agent Registry.

Worker flow:

```text
Orchestrator
-> Agent Registry
-> Worker / Subagent
-> Result
-> Orchestrator
```

Expected worker categories:

```text
Research Worker
Writing Worker
Coding Worker
Testing / Review Worker
Future Domain Workers
```

Internal subagents under `src/workers/<name>/subagents/` are owned by that worker. They must not be exposed directly to `src/agents/orchestrator.ts` or registered as top-level orchestrator tools/subagents.

Workers return structured results.

Workers do not silently mutate global state.


## Registry System

The project uses registries for discoverability and extensibility.

Registries include:

```text
Tool Registry
Skill Registry
Agent Registry
Protocol Access Layer
```

Registries must expose typed interfaces.

Do not bury registry behavior inside the orchestrator.

## Connector System

Connectors normalize external communication into internal events.

Connectors do not contain orchestration logic.

Connector flow:

```text
External Source
-> Connector
-> Normalized Message Event
-> Secure Web API / Gateway
-> Orchestrator
```

Connector examples:

```text
Telegram
Web/API
Scheduled Jobs
Future Connectors
```

Web chat is a client of the Secure Web API.

The Secure Web API is the backend ingress point.

## Secure Web API / Gateway

The Secure Web API receives normalized events and passes them to the orchestrator.

The gateway is responsible for:

```text
authentication
permissions
rate limiting
request validation
audit logging
handoff to orchestrator
```

## RAG System

The orchestrator retrieves information instead of assuming it.

RAG is accessed through a RAG Tool or RAG Router.

RAG flow:

```text
Orchestrator
-> RAG Tool / RAG Router
-> Data Source
-> Retrieved Context
-> Orchestrator
```

Possible data sources:

```text
company documents
Git repositories
SQLite
future vector stores
web search
project memory
client data
```

## RAG And Memory System

Memory is a first-class architecture layer.

Memory is as important as protocols.

The orchestrator uses protocols to know which rules apply.

The orchestrator uses memory and RAG to know which context applies.

After basic chat routing is confirmed, the RAG and Memory architecture should be one of the first systems built.

The RAG architecture must include:

```text
Memory Layer
Web Search Layer
Document Index Layer
Future Vector / DB Retrieval Layer
```

Memory is accessed through tools.

Memory uses a database-backed storage layer.

The first memory priority is retrieval.

Memory retrieval should support:

```text
conversation history
project context
client context
user preferences
workflow state
task history
stored notes
document-index records
```

Memory storage will be expanded over time.

For the first implementation, retrieval is more important than advanced long-term memory writing.

The memory system may begin with the existing `doc-index` approach from OpenClaw and evolve from there.

Memory flow:

```text
Orchestrator
-> Memory Tool / RAG Router
-> Memory Database / Doc Index
-> Relevant Context
-> Orchestrator
```

RAG flow:

```text
Orchestrator
-> RAG Router
-> Memory Layer / Web Search / Docs / Repos / Data Sources
-> Retrieved Context
-> Orchestrator
```

The orchestrator should not assume it knows context when memory or retrieval can provide it.

## Coding Worker System

The Coding Worker is a specialized worker under `src/workers/coding-worker/`.

It must support:

```text
plan
edit
test
debug loop
diff
approval
```

The Coding Worker must run tests before claiming completion.

The Coding Worker must not declare success without verification.

The Coding Worker is orchestrator-only. The main orchestrator exposes only the `coding-worker` lead. Internal `coding-worker-*` subagents must never be visible to the orchestrator.

All mutating side effects (commit, push, repo mutations, GitHub writes) must go through the approval service and be fail-closed.

Execution uses Flue's Node local sandbox, scoped under `workspaceRoot` (`projects/<slug>` or `repos/<slug>`). `process.cwd()` is only a local-dev fallback.

The researcher subagent owns web research. The Coding Worker must not directly call web search or web-capable retrieval paths.

Every turn of the Coding Worker loop — tool execution, subagent handoff, plan update, verification result, commit/push/PR action — must emit structured progress events that reach the user UI. The Coding Worker must not behave like a black box.


## Progress and Handoff Visibility

Every tool execution, subagent delegation, worker handoff, plan update, verification result, and state transition must emit a structured progress event that reaches the user UI.

Do not build workers or subagents that act like black boxes. The user must be able to see what is happening while the agent is working.

Progress events are durable, typed, and routable through the connector layer (Telegram, Web/API, future connectors). They are not informal console logs.

## Required Types

Maintain explicit TypeScript types for:

```text
NormalizedMessageEvent
OrchestratorResponse
ProtocolDefinition
ProtocolBundle
ToolDefinition
SkillDefinition
AgentDefinition
WorkerRunRequest
WorkerRunResult
RegistryLookupResult
RagQuery
RagResult
```

## Suggested Directory Structure

```text
src/
  agents/
  workspace/
  connectors/
  routes/
  middleware/
  memory/
  protocols/
  rag/
  registries/
  skills/
  tools/
  types/
  workers/
  workflows/
  tests/
```

## Required Reading

Before modifying architecture, read:

```text
./agents.md
./agent-flow.svg
https://flueframework.com
https://github.com/withastro/flue
https://flueframework.com/start.md
https://flueframework.com/docs/getting-started/quickstart/index.md
https://flueframework.com/docs/guide/project-layout/index.md
and any other part of their documentation that you can find. Read it all. Understand it all. The project is built on Flue, so understanding Flue is critical before making any modifications.
```

We should discuss protocols, tools, skills, workers, and registries in separate docs that go into more detail on each of those systems. This doc should be a high level overview of the entire architecture and how everything connects together. Each system can have its own doc that goes into more detail on how it works, how to add to it, and best practices for using it.

Before modifying registry behavior, read project registry docs when present:

```text
docs/architecture/registry-system.md
docs/architecture/tool-system.md
docs/architecture/worker-system.md
```

## Verification And Tests

Always run the relevant verification commands before calling work complete.

### Build environment prerequisites (CRITICAL — read every session)

**Node.js:** Use nvm to select Node >= 22.18 (per `engines` in package.json and `rust-toolchain.toml` for the WASM target). Run `nvm use 22` before any pnpm/npx command — older Node versions will fail Flue's build.

**Rust / WASM:**
- Toolchain: `rust-toolchain.toml` — stable, target `wasm32-unknown-unknown`. Run `source ~/.cargo/env` or ensure `cargo` and `wasm-pack` are on PATH.
- WASM crate: `crates/gorombo-memory/` → compiled to `crates/gorombo-memory/pkg/` via `wasm-pack`
- **Build WASM:** `pnpm run wasm:build` (also runs as `prebuild` before `pnpm run build`)
- **WASM artifact is gitignored** — each worktree must build it. Tests SKIP without it.
- **`pnpm run test:unit` does NOT run `prebuild`.** You MUST run `pnpm run wasm:build` before tests if the WASM artifact doesn't exist. If tests show "WASM artifact not built" SKIP, run `pnpm run wasm:build` then re-run tests.

**Embedding model (ONNX):**
- `assets/models/embeddings/all-MiniLM-L6-v2/model.onnx` (90MB, gitignored)
- Fetch: `pnpm fetch-embedding-model`
- Each worktree must fetch it — gitignored, not shared across worktrees.
- Server startup blocks ~30s for ONNX load (event loop blocked, HTTP doesn't respond until done).

**.env file:**
- Copy from `.env.example` and fill in provider secrets. Required: `API_SECRET`. Optional: `OLLAMA_API_KEY`, `RUNPOD_API_KEY`, `CODEX_BRAIN_LOCAL_API_KEY`, `JINA_API_KEY`, etc.
- No TELEGRAM_* — Telegram is optional. No GOROMBO_APPROVAL_ROOT — approval not configured.

**curl 400 known issue:** `curl`/`wget` to Flue routes return 400 with empty body when `x-api-secret` header is long (48+ chars). This is a `@hono/node-server` issue, not our bug. Use Node's `fetch()` or `@flue/sdk` for testing agent endpoints.

### Worktree setup checklist (do ALL before working)

```sh
nvm use 22                                  # Node >= 22.18 required
source ~/.cargo/env 2>/dev/null             # Rust/wasm-pack on PATH
cp .env.example .env           # if .env missing
$EDITOR .env                  # or: nano .env, vim .env, etc.
pnpm install
pnpm fetch-embedding-model                  # if ONNX model missing
pnpm run wasm:build                         # if WASM artifact missing
pnpm run typecheck                           # verify
```

### Running tests

For TypeScript changes, run the project's configured checks from `package.json`. pnpm and npm are both supported in this repository. The Coding Worker resolves the package manager from lockfile presence (`pnpm-lock.yaml` → pnpm, `package-lock.json` → npm) via `src/workers/coding-worker/repo/package-manager.ts`.

Do not invoke `corepack` to launch pnpm — the repo no longer wires corepack into the command builder. Contributors must have pnpm installed (via npm, standalone installer, or Corepack) before running pnpm commands. The `package.json#packageManager` field documents the required version but does not automatically install or shim the binary.

Required one-time setup before running tests: the bundled local embedding model is gitignored (90MB, not committed) and must be downloaded before the embedding/RAG unit tests can pass. Run it once after `pnpm install`:

```sh
pnpm fetch-embedding-model
```

This fetches `assets/models/embeddings/all-MiniLM-L6-v2/` (model.onnx + tokenizer). Without it, the embedding fallback-chain tests fail because the onnx-local provider has no model to run. The cloud provider is expected to 401/403 until a valid cloud embedding key is configured; onnx-local is the working fallback by design.

Typical required checks are:

```sh
pnpm test
pnpm run typecheck
pnpm run build
```

For LSP tool changes, also run the bundled-server integration tests:

```sh
GOROMBO_LSP_REAL_SERVER_TESTS=1 pnpm run test:lsp
```

If the project has a lint/check script, run the named script exactly as configured. Do not assume the tool is called `lint`; it may run ESLint, Biome, Ruff, Prettier, or another checker.

For Python modules, also run the configured Python checks when Python files are changed. Check `pyproject.toml`, `ruff.toml`, `pytest.ini`, `tox.ini`, or `.pre-commit-config.yaml` for the exact commands. Common commands include:

```sh
python -m pytest
ruff check .
ruff format --check .
python -m mypy .
```

Run focused tests first when available, then run the full relevant suite before finishing. If a command cannot be run because dependencies are missing, the environment is unavailable, or the command fails for an unrelated reason, report that clearly with the exact command and error. Do not claim the work is complete or passing unless the required checks were actually run and passed.

I would make the key phrase: **"Do not assume the tool is called lint; run the named script exactly as configured."** That prevents the Ruff/pre-commit/ESLint/Biome confusion you were talking about.

Do not claim tests passed unless they were run.

If a command does not exist, report that it does not exist.

## Dependency Rules

Prefer existing dependencies.

Add dependencies only when required.

Document why any new dependency is added.

Never add a dependency just to avoid writing simple project code.

## Environment Rules

Do not commit secrets.

Use environment variables for:

```text
Telegram tokens
API keys
database URLs
service credentials
```

## Output Rules

At task completion, report:

```text
files created
files modified
commands run
tests run
tests passed
tests failed
assumptions made
next recommended step
```

## Worktree and Swarm Workflow

For substantial repository work, create a sibling worktree. Use the user-specified source branch as the starting point; the default PR base is `main` unless the user explicitly requests otherwise.

When work is large enough to justify parallel agents (a swarm):

1. Settle shared types, schemas, and contracts in a small lead PR first.
2. Spawn sibling worktrees for each parallel workstream, each on its own `codex/...` branch from the most current relevant source branch.
3. Each parallel branch targets `main` and depends only on the shared contract, not on other parallel branches internals.

Before declaring any PR work complete, verify with:

```sh
gh pr view <n> --json number,url,state,isDraft,baseRefName,headRefName
```

Confirm `baseRefName` is the intended base (usually `main`) and, when review automation is expected, `isDraft` is `false`.

## Architecture Boundaries

Protocols are stored in SQLite.

Protocols are loaded through the Protocol Tool.

The orchestrator calls the Protocol Tool on every orchestration call.

Protocols are first-class directives.

Memory is a first-class architecture layer.

Memory is as important as the Protocol System.

Protocols provide applicable rules.

Memory provides applicable context.

Memory retrieval is prioritized before advanced memory storage.

After basic chat routing is operational, Memory and RAG should be among the first major systems implemented.

The initial memory architecture may leverage the existing doc-index approach.

Connectors do not orchestrate.

Connectors only normalize external communication into internal events.

Tools execute capabilities.

Skills describe workflows.

Workers perform specialized execution.

Registries provide discoverability.

The orchestrator coordinates the system.

## Agent skills

### Issue tracker

Issues live in GitHub (`dansasser/sim-one-alpha`), via the `gh` CLI. External PRs are not a triage surface — only issues are triaged. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` + `docs/adr/` at the repo root (created lazily by `/domain-modeling`; neither exists yet). See `docs/agents/domain.md`.
