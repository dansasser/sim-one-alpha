# Architecture Overview

SIM-ONE Alpha is a governed, multi-purpose AI employee system built by
[Gorombo](https://gorombo.com). It combines the
[Flue](https://flueframework.com/) agent runtime with the
[SIM-ONE Framework](https://simoneframework.org/) governance model.

Flue provides the durable execution architecture. SIM-ONE defines how that
architecture applies protocols, context, delegation, scoring, approvals, and
memory. SIM-ONE Alpha is the product implementation of both layers.

## Product Identity

```text
Gorombo       company
SIM-ONE Alpha product and AI employee system
SIM-ONE       governance and execution framework
Flue          TypeScript agent runtime and harness
sim-one       product command
```

Workers are internal SIM-ONE Alpha executors, not independent products or
public agent endpoints.

## Governed Runtime Flow

```text
Terminal / connector / Web API / schedule
-> Secure gateway
-> Trusted normalized event
-> Durable Flue orchestrator session
-> SQLite protocol lookup
-> Orchestrator/critic admission
-> Memory, RAG, tools, workers, workflows, or MCP
-> Structured result returned to orchestrator/critic
-> Protocol scoring and response validation
-> Approval, revision, rejection, or response
```

The orchestrator is the middleman for every agent action and flow. It owns
security, protocol application, governance, delegation, and final validation.
Workers perform bounded work and report results back; they do not approve their
own work or bypass the orchestrator.

## Flue Runtime Foundation

Flue supplies:

- durable agents and sessions;
- workflows and actions;
- tools and MCP connections;
- skills;
- workers through subagent profiles;
- persistence and compaction;
- streaming events and observability;
- routing and deployable Node runtimes;
- sandbox adapters for bounded execution.

SIM-ONE Alpha mounts the Flue runtime behind its gateway and keeps application
orchestration out of the HTTP entrypoint.

See:

- [Flue Architecture Contract](flue-architecture.md)
- [Orchestrator Flow](orchestrator-flow.md)
- [Flue documentation](https://flueframework.com/)

## SIM-ONE Governance Layer

The SIM-ONE Framework adds the control plane applied around Flue execution:

- runtime protocols;
- governing orchestrator/critic behavior;
- intent and flow admission;
- worker and tool selection;
- structured scoring and validation;
- approval boundaries;
- retrieval and memory policy;
- trusted connector and actor scope;
- final response authority.

The protocol database is outside model context. The model receives the
applicable protocol bundle through a tool call; it does not author or silently
change the governing rules.

See the [SIM-ONE Framework](https://simoneframework.org/) for the framework
model and protocols.

## Protocols

Protocols are mandatory runtime rules stored in SQLite. They are not skills,
prompts, or optional capability instructions.

Protocol matching can use:

```text
connector
actor and user
client
project
task
workflow
message type
priority
enabled state
```

The orchestrator loads the applicable bundle before final reasoning, tool
execution, delegation, or response generation.

## Orchestrator And Workers

The orchestrator is responsible for:

- intent detection;
- protocol loading;
- planning and routing;
- context retrieval;
- tool and workflow selection;
- worker delegation;
- result evaluation;
- response synthesis.

Workers are specialized executors. The built-in researcher owns source-backed
web research. The Coding Worker owns code planning, editing, testing, review,
and approval-gated repository actions. Internal worker subagents remain
private to their owning worker.

Progress from tool calls, worker handoffs, verification, approvals, and state
transitions is emitted as structured runtime activity rather than hidden
background work.

## Tools, Skills, Workers, And MCP

SIM-ONE Alpha exposes two capability layers:

| Layer | Contents |
| --- | --- |
| Built-in Flue layer | Product-shipped skills, tools, workers, workflows, and MCP connections |
| Runtime registry | User- or agent-added skills, tools, workers, and MCP servers |

Enabled runtime capabilities merge into the same governed Flue surfaces as
built-ins. They do not override protocols, trusted scope, approvals, or
orchestrator validation.

See:

- [Extending SIM-ONE Alpha](../guides/extending-sim-one.md)

## Memory And Retrieval

Protocols tell the system which rules apply. Memory and RAG provide the context
needed to perform the work.

SIM-ONE Alpha separates:

- durable Flue session state;
- connector and logical session metadata;
- Rust/WebAssembly structured memory for checklists, todos, and notes;
- semantic retrieval and embeddings;
- indexed knowledge;
- web research;
- task and project context.

Structured-memory scope comes from trusted connector, actor, conversation,
thread, and project data, not model-selected arguments.

See [Memory System](memory-system.md).

## Gateway And Connectors

The gateway owns:

- authentication;
- permissions;
- rate limits;
- request validation;
- trusted connector identity;
- audit and telemetry handoff;
- session ownership;
- orchestrator admission.

Connectors normalize external messages and return responses through the
initiating channel. They do not contain orchestration logic.

See:

- [Connectors And Pairing](../guides/connectors.md)
- [HTTP API Reference](../reference/http-api.md)

## Persistence

Flue SQLite stores durable runtime state such as sessions, submissions, runs,
and event streams. SIM-ONE application databases store protocols, logical
session metadata, structured memory, schedules, capabilities, retrieval data,
and approvals.

Keeping these stores distinct allows Flue to resume execution while SIM-ONE
Alpha controls rules, context, identity, and product-owned state.

## Security Boundaries

SIM-ONE Alpha applies security at multiple boundaries:

1. The gateway verifies external access and connector identity.
2. Session routing enforces actor and conversation ownership.
3. The orchestrator loads protocols before execution.
4. Registries expose only enabled and valid capabilities.
5. Workers receive bounded tasks and return structured results.
6. Mutating work enters approval-gated paths.
7. The orchestrator/critic evaluates results and the final response.
8. Credentials and protocol records remain outside model context.

DM pairing, allow lists, API authentication, and connector permissions protect
ingress. The architectural difference is that the orchestrator remains the
governing authority between every admitted request and every executable action.

## Related Documentation

- [Documentation Hub](../README.md)
- [Configuration Reference](../reference/configuration.md)
- [Terminal And Session Guide](../guides/terminal-and-sessions.md)
- [HTTP API Reference](../reference/http-api.md)
