# AGENTS.md

## Project Overview

This repository contains the GOROMBO multi-purpose orchestrating agent.
Never edit the main branch.
Always create a new branch for your work, and open a pull request when ready.  

The system is built with Flue. A Typescript-based agent framework built by the Astro team.

The main orchestrating agent receives messages from connectors, loads applicable protocols from SQLite, retrieves context when needed, uses tools, delegates work to workers/subagents, validates results, and returns a response.

The orchestrator is a coordinator, not a hardcoded knowledge base.

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

Workers are specialized executors.

Workers may operate independently or be invoked by the orchestrator.

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

The Coding Worker is a specialized worker.

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
  gateway/
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

For TypeScript changes, run the project’s configured checks from `package.json`. Prefer the repo’s package manager based on the lockfile:

- `pnpm` if `pnpm-lock.yaml` exists
- `npm` if `package-lock.json` exists
- `yarn` if `yarn.lock` exists
- `bun` if `bun.lockb` or `bun.lock` exists

Typical required checks are:

```sh
<package-manager> test
<package-manager> run typecheck
<package-manager> run build
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

I would make the key phrase: **“Do not assume the tool is called lint; run the named script exactly as configured.”** That prevents the Ruff/pre-commit/ESLint/Biome confusion you were talking about.

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
