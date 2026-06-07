# astro-flue-agent (GOROMBO Agent)

GOROMBO Agent is a Flue-based agent project for building practical AI Employees, business automation workflows, research assistants, coding workers, connected chat experiences, and operational AI systems.

It is built on [Flue](https://flueframework.com), a TypeScript agent harness framework from the Astro ecosystem.

GOROMBO Agent adds its own protocol system, memory layer, RAG architecture, registry-driven tools, registry-driven skills, registry-driven workers, Telegram/API connectors, and business workflow patterns on top of Flue.

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
- Placeholder structure for future coding-worker workflows
- Business-focused AI Employee architecture

## Why Flue

GOROMBO Agent is built with Flue because Flue provides the programmable agent harness layer needed for real agent workflows.

Flue gives the project a foundation for:

- agents
- sessions
- tools
- skills
- workflows
- filesystem access
- sandboxed execution
- deployable runtimes

GOROMBO Agent builds on that foundation with:

- protocols
- memory
- retrieval
- registries
- connectors
- business workflows
- worker orchestration

Flue provides the harness.

GOROMBO Agent defines the operating system built on top of it.

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

Memory is a first-class architecture layer.

Protocols provide rules.

Memory provides context.

Memory will use a database-backed storage and retrieval layer.

The first memory priority is retrieval, especially:

- conversation history
- project context
- client context
- user preferences
- workflow state
- task history
- stored notes
- document-index records

The initial memory architecture may start from the existing `doc-index` approach and grow from there.

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
mongoDB
Node.js
```

Primary storage roles:

```text
SQLite = protocol storage

Database-backed memory = memory retrieval and context storage

Future stores = vector search, document indexes, client data, project data
```

## Project Structure

Planned structure:

```text
src/
  agents/
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

## Installation

This project is currently in early development.

Clone the repository:

```sh
git clone <repository-url>
cd <repository-name>
```

Install dependencies using the package manager used by the repo:

```sh
npm install
```

Run the development server or local workflow command defined in `package.json`:

```sh
npm run dev
```

Run tests:

```sh
npm test
```

Run type checks:

```sh
npm run typecheck
```

Build the project:

```sh
npm run build
```

Use the actual scripts defined in `package.json`.

Do not assume a command exists unless it is configured in the project.

## Configuration

Environment variables are used for secrets and service configuration.

Expected future environment values may include:

```text
TELEGRAM_BOT_TOKEN
DATABASE_URL
PROTOCOL_DB_PATH
MEMORY_DB_URL
API_SECRET
MODEL_PROVIDER_API_KEY
```

Do not commit real secrets.

Use local `.env` files or the deployment platform’s secret manager.

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
- web search provider placeholder
- registry interfaces
- worker interfaces

Use small, testable steps.

Do not build the entire final system in one pass.

## Testing

Run relevant verification before calling work complete.

Common commands:

```sh
npm test
npm run typecheck
npm run build
```

If the project defines other scripts in `package.json`, use those exact scripts.

Do not claim tests passed unless they were actually run.

## Roadmap

Near-term:

- base Flue agent
- Telegram connector
- Secure Web API / Gateway
- normalized message event flow
- SQLite protocol storage
- protocol loading tool
- memory retrieval interface
- initial RAG architecture
- web search placeholder
- document-index placeholder
- registry interfaces
- worker interfaces

Mid-term:

- database-backed memory
- richer document indexing
- runtime tool gateway
- user-defined tools
- user-defined skills
- user-defined workers
- approval gates
- observability
- persistent sessions

Long-term:

- production AI Employee deployments
- client-specific memory
- client-specific protocols
- coding-worker loop
- sandboxed code execution
- testing and review workers
- business automation packages
- marketplace-style capability registry

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

GOROMBO Agent is built with [Flue](https://flueframework.com), the TypeScript agent harness framework from the Astro ecosystem.

Flue provides the underlying agent harness.

GOROMBO Agent adds protocol, memory, registry, connector, retrieval, worker, and business workflow layers on top of Flue.

## Guiding Principle

GOROMBO Agent is not built around one giant prompt.

It is built around an agent that can coordinate rules, memory, retrieval, tools, skills, workers, registries, and connectors.

```text
Protocols provide rules.

Memory provides context.

RAG provides knowledge.

Tools provide actions.

Workers provide specialized execution.

The agent coordinates the system.

```
