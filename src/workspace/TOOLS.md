# TOOLS.md

## Purpose

Guides the main agent on when and how to use attached tools, workflows, and subagents.

Tool availability is determined by Flue configuration and attached runtime tools. This file explains tool-use guidance; it does not create tools by itself.

## Current Main-Agent Capabilities

- `load_protocols`: load applicable protocol directives before final reasoning.
- `retrieve_memory`: retrieve relevant stored context when memory would materially help.
- Flue task delegation: delegate focused work to registered subagents.
- `researcher` subagent: owns source-backed web research through its `web_research` tool.

## Required Operating Flow

- Use `load_protocols` before final reasoning, tool use, delegation, or final response.
- Use `retrieve_memory` when stored conversation, user, project, or task context would materially improve the response.
- Use subagents for substantive specialist work instead of doing that work directly in the main agent.
- Do not claim tools, accounts, integrations, providers, workflows, or scheduled tasks are live unless they are actually available.

## Research Delegation

Delegate to the `researcher` subagent when the task involves:

- web search
- current, latest, recent, or time-sensitive information
- external facts that need source backing
- official URLs, documentation, API references, or product pages
- comparisons that require sources
- source-backed summaries or citations
- deep research, investigation, or multi-source synthesis

Do not call web-search-capable tools directly from the main agent. The researcher owns `web_research`.

## Research Depth Selection

Ask the researcher for `depth: "basic"` when the user needs:

- one source-backed fact
- an official URL
- a quick documentation lookup
- a simple current-status check

Ask the researcher for `depth: "standard"` when the user needs:

- a source-backed explanation
- a comparison
- a short research summary
- a recommendation that depends on current or external sources

Ask the researcher for `depth: "deep"` when the user needs:

- extended investigation
- multi-source synthesis
- competing-claim analysis
- a high-impact decision
- broader evidence, follow-up searches, and confidence limits

## Delegation Request Shape

When delegating research, include:

- the research question
- why the information is needed
- desired depth: `basic`, `standard`, or `deep`
- freshness requirement when relevant
- output shape requested by the user
- any known constraints, such as preferred source type, official-source requirement, or maximum length

Keep the request concise. Do not include private user, company, workspace, memory, or conversation context unless it is relevant, allowed, and needed for the research task.

## Handling Research Results

When the researcher returns findings:

- validate that the result answers the delegated question
- preserve source URLs when they are useful to the user
- mention `providerFailures` when they affect confidence
- separate source-backed findings from inference when confidence matters
- synthesize the final answer for the user instead of dumping raw tool output

## Memory Tool Guidance

Use `retrieve_memory` for internal context, not web facts.

Good memory retrieval cases:

- user preferences
- project decisions
- previous task state
- conversation continuity
- stored notes or durable context

Do not use memory as a substitute for fresh research when the answer depends on current, changing, or source-backed external facts.

## Tool Boundaries

- Main-agent tools support orchestration, protocols, memory lookup, delegation, and synthesis.
- Research tools belong to the researcher unless explicitly attached to the main agent in a future architecture change.
- Security and approval requirements belong in `SECURITY.md`.
- Detailed researcher method belongs in the researcher's `TOOLS.md`.
