# Flue Architecture Contract

This document is the local source of truth for Flue architecture in this repository. Read it before modifying `src/app.ts`, agents, workflows, tools, skills, subagents, model cards, provider runtime, memory, RAG, or routing.

## Flue Components

Flue applications are built from these components:

```text
app.ts
agents
agent profiles
subagents
workflows
tools
skills
models
model providers
model specifiers
sessions
persistence
compaction
sandboxes
routing
observability
durable workflow runs
MCP servers
CLI
SDK
```

## app.ts

`src/app.ts` is an optional Hono application entrypoint. It composes app-owned routes and middleware with Flue's generated routes.

Allowed in `src/app.ts`:

```text
Hono app creation
health checks
auth and middleware
custom ingress that forwards into Flue architecture
app.route('/', flue())
side-effect import of model runtime bootstrap
```

Not allowed in `src/app.ts`:

```text
orchestration logic
direct RAG router creation
direct web-search provider creation
old/non-Flue orchestrator wiring
passing process.env into model-provider setup
agent business logic
```

If app-owned ingress is needed, it must dispatch or invoke the Flue agent/workflow path. It must not call a separate non-Flue orchestrator.

## Agents

An agent file is a Flue `createAgent(...)` entrypoint. Every agent has a main file. A subagent is just another agent profile called by an agent.

Agents own:

```text
model selection
instructions
tools
skills
subagents
session persistence
compaction
sandbox settings
```

Agents use model specifiers from project model cards. They do not hardcode provider credentials.

## Workflows

Workflow files live under `src/workflows/` and export `run(...)`. Workflows are finite application-controlled operations.

Workflows may:

```text
normalize input
load app data
initialize agents with init(agent)
open sessions
call prompt/task/skill
manage bounded application loops
use caches
return structured results
```

Workflows are first-class Flue architecture. Complex research machinery may live in workflow files when the owning agent is the researcher.

## Tools

Tools are executable capabilities created with `defineTool(...)`.

Tools must be attached only to agents that should own those capabilities. Do not attach web-search-capable tools to the orchestrator.

## Skills

Skills are reusable workflow knowledge and instructions. Skills do not execute actions by themselves. Tools and workflows execute actions.

## Subagents

Subagents are named agent profiles available to a parent agent through Flue task delegation. They run in child sessions and return results to the parent.

The orchestrator may delegate to subagents. Subagents may use their own tools, skills, workflows, model, and instructions.

## Models And Providers

Model cards define:

```text
model key
provider id
model id
specifier
roles
capabilities
context limits
output limits
environment variable names for provider config
source metadata
```

Model cards do not contain secret values.

Provider runtime resolves the card-declared environment variable names against the runtime environment and registers Flue providers.

## GOROMBO Boundary

The orchestrator routes and delegates. The researcher owns web research.

```text
User prompt
-> chat workflow / Flue route
-> orchestrator agent
-> load_protocols
-> safe memory lookup if useful
-> delegate to researcher if web/current/source-backed information is needed
-> researcher performs web research
-> orchestrator synthesizes the final response
```

The orchestrator must not directly call web search or a web-capable retrieval path.
