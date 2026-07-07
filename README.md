# SIM-ONE Alpha

![Status](https://img.shields.io/badge/status-release-blue)
[![Gorombo](https://img.shields.io/badge/by-Gorombo-black)](https://gorombo.com)
![Node.js](https://img.shields.io/badge/node-%3E%3D22.18-brightgreen)
![TypeScript](https://img.shields.io/badge/typescript-6.x-blue)
[![Built with Flue](https://img.shields.io/badge/built%20with-Flue-purple)](https://flueframework.com/)
[![SIM-ONE Framework](https://img.shields.io/badge/framework-SIM--ONE-blueviolet)](https://simoneframework.org)
![License](https://img.shields.io/badge/license-MIT-blue)

SIM-ONE Alpha is a protocol-governed AI employee from [Gorombo](https://gorombo.com), built with [Flue](https://flueframework.com/) and the [SIM-ONE Framework](https://simoneframework.org). It is the base architecture behind Gorombo's AI Employees: a self-hosted runtime that combines protocols, memory, RAG, workers, tools, schedules, connectors, approvals, and local computer control so AI employees can receive work, learn as they work, and act through governed execution paths.

## Table of Contents

- [Status](#status)
- [What Is SIM-ONE Alpha?](#what-is-sim-one-alpha)
- [SIM-ONE Alpha vs OpenClaw and Hermes Agent](#sim-one-alpha-vs-openclaw-and-hermes-agent)
- [Why Governance Matters](#why-governance-matters)
- [Features](#features)
- [Quick Start](#quick-start)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
- [Architecture](#architecture)
- [Extensibility](#extensibility)
- [Documentation](#documentation)
- [Development](#development)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [Maintainers / Author](#maintainers--author)
- [Code of Conduct](#code-of-conduct)
- [Security](#security)
- [License](#license)
- [Attribution](#attribution)

## Status

SIM-ONE Alpha is the base architecture behind [Gorombo](https://gorombo.com)'s AI Employees. It ships as a self-hosted AI employee runtime with the `sim-one` CLI, Ratatui terminal UI, Web UI, gateway API, connectors, scheduled jobs, runtime capability management, memory/RAG, worker delegation, protocol loading, and approval-gated local actions.

## What Is SIM-ONE Alpha?

SIM-ONE Alpha is an AI employee system: an agent runtime that can receive work, load operating rules, remember context, retrieve knowledge, delegate specialized tasks, use tools, and report back through connected interfaces.

It is built to be an AI employee you can trust because control does not live in one long assistant prompt. Every request enters through an orchestrator; protocols define the applicable rules; memory and RAG provide grounded context; registries define available skills, tools, workers, and MCP servers; workers handle specialized execution; tools expose bounded actions; and approvals gate risky changes.

The model still reasons, but the runtime governs how work is admitted, routed, executed, validated, and remembered. As work history, documents, preferences, and capabilities grow, SIM-ONE Alpha learns as it works without moving authority out of the governed execution layer.

## SIM-ONE Alpha vs OpenClaw and Hermes Agent

SIM-ONE Alpha belongs in the same broader category as [OpenClaw](https://github.com/openclaw/openclaw) and [Hermes Agent](https://github.com/NousResearch/Hermes-Agent): self-hosted AI agents that can use tools, remember context, connect to external channels, automate work, and improve over time.

The difference is architectural. SIM-ONE Alpha uses [Flue](https://flueframework.com/) as the agent harness and layers the [SIM-ONE Framework](https://simoneframework.org) on top of it so governance is not just prompt text. The orchestrator is the mandatory control plane for all action and flow: it loads runtime protocols, checks permissions, selects capabilities, delegates to workers, validates results, and rejects work that is outside policy.

| Area | OpenClaw | Hermes Agent | SIM-ONE Alpha |
| --- | --- | --- | --- |
| Product class | Local-first personal AI assistant and agent gateway | Self-improving assistant and automation agent | Protocol-governed AI employee runtime |
| Primary promise | A personal assistant that can connect across messaging surfaces and local automation | An agent that grows through tools, skills, memory, MCP, schedules, and gateway control | AI employees that receive work, remember context, delegate execution, and act through governed runtime paths |
| Interfaces | Messaging gateway, local app/runtime, and assistant surfaces | CLI, messaging gateway, scheduled execution, and agent runtime surfaces | `sim-one` CLI, Ratatui terminal UI, Web UI, gateway API, connectors, and scheduled jobs |
| Security architecture | Controls sit around the assistant session, gateway, and tool execution path | Controls sit around the agent loop, tools, skills, MCP, schedules, approvals, and subagents | The orchestrator is the required enforcement layer for every action: protocols are loaded from the runtime database, capabilities are selected through registries, workers report back, and disallowed work is rejected before it continues |
| Authority model | The assistant session is the primary control surface for reasoning, tool use, and user interaction | The agent control loop coordinates tools, skills, memory, schedules, approvals, and subagents | The orchestrator is the mandatory control plane between users, protocols, memory, tools, workers, approvals, and final response |
| Governance source | Assistant instructions, settings, tool policies, workflow behavior, and gateway configuration | Assistant instructions, skills, tools, approval flows, gateway configuration, and runtime settings | SQLite-backed protocol records loaded at runtime before reasoning, tool execution, worker delegation, or response generation |
| Task execution | The assistant can use available tools and automation paths directly within its session model | The agent uses tools, skills, schedules, MCP, and subagents to complete work | Workers execute specialized work; the orchestrator governs routing, policy, validation, and final response |
| Workers / subagents | Subagents and assistant workflows extend the main assistant experience | Subagents support task specialization inside the agent system | Workers are first-class executors that report back to the orchestrator instead of owning final authority |
| Memory and learning | Assistant memory and context support continuity and personalization | Persistent memory, skills, and workflows support agent growth over time | Memory, RAG, work history, and capability records are retrieved and applied through the governed runtime |
| Skills / tools / MCP | Tools and assistant capabilities enable local and connected automation | 40+ tools, skills, MCP, and automation capabilities | Dual-layer capability model: Flue-native built-ins plus SIM-ONE runtime registry for skills, tools, workers, and MCP servers without rebuilding |
| Workflows and schedules | Agent workflows and messaging automation support repeated tasks | Cron scheduling and reusable skills/workflows support recurring automation | Schedules are agent-turn triggers routed through the same gateway, orchestrator, protocol, memory, and approval model |
| Approvals and mutations | Tool and host access depend on the configured context and execution mode | Command approval and container isolation control risky execution paths | Risky side effects move through approval-gated mutation paths; workers do not silently mutate global state |
| Best fit | Personal AI assistant and multi-channel local automation | Self-improving automation agent for users who want broad tool reach | AI employee platform where governance, auditability, and enforced operating rules matter |

## Why Governance Matters

Most agents can be given rules. The hard part is making sure those rules remain in force when the agent starts using tools, delegating work, writing files, scheduling tasks, or acting on a local machine.

SIM-ONE Alpha handles that by putting the orchestrator in the middle of every action. Users do not talk directly to workers. Workers do not silently own final authority. Tools are not available merely because the model saw them in a prompt. Every normal request moves through a more linear, auditable path:

```text
User or connector
-> Gateway
-> Orchestrator
-> Runtime protocols
-> Registries / memory / workers / tools
-> Approval gates when needed
-> Validation
-> Response
```

The orchestrator governs. Workers execute.

Protocols are runtime rule records stored in SQLite, not just instructions inside the model context. The orchestrator loads those protocols before final reasoning, tool execution, worker delegation, or response generation. Capabilities are exposed through registries. Workers report back to the orchestrator. Approval paths gate risky mutations.

That is the SIM-ONE Alpha difference: security and governance are part of the runtime architecture, not only a set of reminders inside an assistant prompt.

## Features

<!-- Scannable grouped bullets: protocols, memory/RAG, workers, tools, connectors, TUI/API, approvals, extensibility. -->

## Quick Start

<!-- Fastest path from clone to running local TUI/server. -->

## Installation

<!-- Prerequisites, clone, dependencies, one-time assets, build-from-source notes. -->

## Configuration

<!-- Required/optional environment variables and runtime config file. -->

## Usage

<!-- TUI, server, HTTP API, research workflow, capability commands. -->

## Architecture

<!-- Short overview only; link to deeper docs instead of duplicating them. -->

## Extensibility

<!-- Skills, tools, workers, MCP servers, and runtime capability registry. -->

## Documentation

<!-- Canonical docs index and links to architecture, operations, and agent docs. -->

## Development

<!-- Setup, build, test, typecheck, useful scripts, worktree expectations. -->

## Roadmap

<!-- Short future direction section. Keep release features out of roadmap. -->

## Contributing

<!-- Contribution model, GitHub issues, PR expectations, development-phase note. -->

## Maintainers / Author

<!-- Gorombo, Daniel T Sasser II, project links, ownership. -->

## Code of Conduct

<!-- Community expectations or link to CODE_OF_CONDUCT.md when present. -->

## Security

<!-- Responsible disclosure, no secrets in issues, approval-gated action model. -->

## License

<!-- Actual license statement or current license status. -->

## Attribution

<!-- Gorombo, Flue, Astro ecosystem, SIM-ONE Framework, and other required acknowledgements. -->
