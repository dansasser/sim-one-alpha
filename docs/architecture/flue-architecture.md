# Flue Architecture Contract

This document is the local source of truth for Flue architecture in this repository. Read it before modifying `src/app.ts`, agents, workflows, tools, skills, subagents, model cards, provider runtime, memory, RAG, or routing.

## Flue Components

Flue applications are built from these components:

```text
app.ts
agents
Flue agent profiles
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
auth and middleware (loopback bypass for local TUI, x-api-secret for external connectors)
imported route registration
custom ingress that forwards into Flue architecture
telemetry observer registration
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

Telemetry observers registered in `src/app.ts` must stay lightweight. Use Flue `observe(...)` for live runtime events, sanitize content-bearing events before exposing or exporting them, and keep protected telemetry routes in imported route modules.

If app-owned ingress is needed, it must dispatch or invoke the Flue agent/workflow path. It must not call a separate non-Flue orchestrator. Auth checks should live in imported middleware modules, not inline route bodies.

## Agents

An agent file is a Flue `createAgent(...)` entrypoint. Every agent has a main file. A subagent is a Flue agent profile called by an agent. In this project, that Flue term is not a model-selection concept; model selection always goes through project model cards.

The main agent entrypoint lives at `src/engine/agents/orchestrator.ts`. A re-export shim at `src/agents/orchestrator.ts` satisfies Flue's hardcoded discovery path. Subagent implementations live under `src/engine/workers/<name>/` so they do not sit at the same directory level as the main agent. The main agent workspace lives at `src/workspace/`; subagent workspaces live at `src/engine/workers/<name>/workspace/`.

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

Workflow files live under `src/engine/workflows/` and export `run(...)`. Workflows are finite application-controlled operations.

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

Workflow files expose HTTP by exporting `route`. Flue workflow HTTP invocation is asynchronous by default: accepted calls return a workflow `runId`, and clients inspect `/runs/:runId` for the completed result. Workflows are finite operations, not the durable continuing chat boundary.

## Tools

Tools are executable capabilities created with `defineTool(...)`.

Tools must be attached only to agents that should own those capabilities. Do not attach web-search-capable tools to the orchestrator.

## Skills

Skills are reusable workflow knowledge and instructions. Skills do not execute actions by themselves. Tools and workflows execute actions.

## Subagents

Subagents are named Flue agent profiles available to a parent agent through Flue task delegation. They run in child sessions and return results to the parent. They still use model specifiers supplied by project model cards.

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

## SIM-ONE Alpha Boundary

The orchestrator routes and delegates. The researcher owns web research.

```text
User prompt
-> app-owned chat ingress
-> durable orchestrator agent session
-> orchestrator agent
-> load_protocols
-> safe memory lookup if useful
-> delegate to researcher if web/current/source-backed information is needed
-> researcher performs web research
-> orchestrator synthesizes the final response
```

The orchestrator must not directly call web search or a web-capable retrieval path.
