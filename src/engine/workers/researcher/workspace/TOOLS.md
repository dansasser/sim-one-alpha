# TOOLS.md

## Purpose

Guides researcher-owned tool use, including when to use basic web search, standard research, and deep research.

Tool availability is determined by Flue configuration and attached runtime tools. This file explains when and how to use available tools; it does not create tools by itself.

## Current Researcher Capabilities

- `web_research`: runs the researcher-owned research workflow with query planning, cache, web search, page fetch, source packing, confidence metadata, provider failure reporting, and research depth controls.

## Research Depth

Use `web_research` for source-backed, current, external, or web-backed research.

Choose `depth: "basic"` for:

- one fact
- official URL or documentation lookup
- quick current status
- simple source-backed confirmation

Choose `depth: "standard"` for:

- comparisons
- source-backed explanations
- light product, market, or documentation research
- tasks where source quality matters but a long investigation is not needed

Choose `depth: "deep"` for:

- extended investigation
- multi-source synthesis
- competing claims
- high-impact decisions
- tasks that require broader evidence, follow-up searches, and confidence limits

## Cache And Freshness

- Use default cache behavior when the task does not depend on rapidly changing information.
- Use `freshness: "fresh"` when the request asks for current, latest, recent, today, news, active documentation changes, schedules, prices, laws, people in current roles, or other unstable facts.
- Use `freshness: "cached"` only when speed is more important than recency and cached evidence is acceptable.
- Report cache or provider limitations when they affect confidence.

## Fetching Pages

- Use `webFetch: "auto"` for most basic and standard research.
- Use `webFetch: "always"` when source details matter, the answer depends on exact page content, or the task is deep research.
- Use `webFetch: "never"` only when snippets are enough or budget must be tightly limited.

## Budget Guidance

- Let the depth defaults work unless the request needs tighter or broader limits.
- Increase `maxQueries`, `maxFetches`, and `maxContextTokens` for deep research.
- Keep explicit budgets bounded; do not turn deep research into an unbounded loop.
- Use `minSources` when a task requires a minimum evidence base.
- Use `maxIterations` for deep research that needs multiple bounded search rounds.

## Result Handling

After calling `web_research`:

- compare sources before answering when multiple sources are returned
- preserve source URLs from returned metadata when available
- separate evidence from inference
- include `providerFailures` when they affect confidence
- return concise structured findings that the main agent can use directly

## Tool Boundaries

- Low-level retrieval and search behavior belongs to researcher-owned tools and workflows.
- Do not use main-agent-only tools unless they are explicitly attached to this subagent.
- Tool availability is determined by Flue agent configuration and registries, not by this file.
- Do not claim deep research, cache inspection, provider access, or page fetch capabilities beyond what the attached tool reports.
