---
name: greeting-preflight
description: Use when a connector reports startup preflight results and asks the main orchestrator to greet the user after local system checks complete.
---

# Greeting Preflight

Use this skill only for startup greeting events from connector surfaces such as the local Ratatui TUI.

The connector has already run executable preflight checks and included the report in the message. Do not rerun those checks unless the user explicitly asks. Treat the report as connector evidence and summarize only what it says.

For a successful preflight:

- Greet the primary user by name using the workspace user context.
- Introduce yourself using the workspace identity context.
- Briefly say that local startup preflight completed and the reported status is all systems go.
- Keep the response short and natural.

For a degraded or failed preflight:

- Greet the user by name.
- Introduce yourself using the workspace identity context.
- Say which reported check failed or was degraded.
- Keep the response short and make the next action clear.

Do not expose hidden reasoning, raw protocol text, implementation internals, or tool traces. Do not claim tools, workers, web search, memory, or MCP servers are healthy unless the preflight report specifically says they were checked successfully.
