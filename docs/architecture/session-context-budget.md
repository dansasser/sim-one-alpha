# Session Context Budget

Last checked: 2026-06-07.

## Flue Session Findings

Flue sessions are named conversation state inside an initialized harness. `harness.session(name)` gets or creates a session, while `harness.sessions.get(name)` only loads an existing session and throws when it does not exist. A session runs one active `prompt`, `skill`, `task`, `shell`, or `compact` operation at a time.

Sources:

- Flue Agent API: https://flueframework.com/docs/api/agent-api/
- Flue Data Persistence API: https://flueframework.com/docs/api/data-persistence-api/
- Installed runtime types: `node_modules/@flue/runtime/dist/types-CEfuEx4p.d.mts`
- Installed runtime implementation: `node_modules/@flue/runtime/dist/sandbox-C2jFycj2.mjs`

Flue persists session state through `SessionStore`. `SessionData` stores a history tree with message entries, compaction entries, branch summaries, metadata, and timestamps. On Node with no `persist` override, session state uses process-memory storage. On Cloudflare Durable Object-backed paths, Flue uses durable session storage when the durable storage context is available. A created agent can return `persist` to provide a custom durable store.

`session.prompt(...)` appends the user prompt to the active session and runs against the session's current conversation context. The runtime rebuilds the agent harness state from stored session history when opening a session, then syncs newly produced messages back into session history after each prompt.

`PromptResponse.usage` is post-call telemetry. Flue aggregates token and cost usage across model work performed by one `prompt`, `skill`, or `task` call. The installed runtime also folds compaction summarization usage into the operation that triggered compaction.

Flue exposes compaction in two ways:

- Agent config accepts `compaction: false | CompactionConfig`.
- `session.compact()` triggers compaction immediately and resolves without work when there is nothing to compact.

`CompactionConfig` has `reserveTokens`, `keepRecentTokens`, and `model`. Flue automatic threshold compaction triggers when the current context token count is greater than `contextWindow - reserveTokens`. The installed runtime estimates context with provider usage from the latest assistant message plus a character-count estimate for trailing messages. It also has overflow recovery that compacts and retries after a provider context overflow.

Flue does not expose a public pre-prompt exact token count for application code in the installed `@flue/runtime` package. GOROMBO owns the pre-prompt budget layer by estimating the next prompt and previously recorded session usage before calling `session.prompt(...)`.

## Implemented GOROMBO Layer

The selected model card now drives context budgeting and compaction:

- `src/models/cards/index.ts` resolves a Flue model specifier to a project-owned model card.
- `src/session/context-budget.ts` calculates enforced context, output reserve, usable input, warning threshold, compaction threshold, and hard-stop threshold.
- `src/session/compaction-policy.ts` converts token estimates into `normal`, `warn`, `compact`, or `stop`.
- `src/session/session-budget.ts` keeps an in-process per-session ledger for prompt usage estimates.
- `src/workflows/chat.ts` evaluates the next prompt before calling `session.prompt(...)`.
- `src/agents/orchestrator.ts` passes card-derived Flue compaction settings to `createAgent(...)`.

The chat workflow sequence is:

```text
normalize message
-> resolve selected model card
-> estimate session history plus next prompt
-> warn, compact, or stop
-> call session.compact() when compaction is required
-> refuse the prompt when the hard input budget is still exceeded
-> session.prompt(...)
-> record PromptResponse.usage into the session budget ledger
-> return contextBudget telemetry
```

This keeps Flue's native automatic compaction enabled and adds a GOROMBO pre-send guard before the provider receives an oversized prompt.

## Budget Inputs

- selected model card
- Flue model specifier
- advertised model context window
- guaranteed context window
- provider-reported context window
- capped output reserve
- usable input budget
- current session/history usage estimate
- current prompt estimate
- protocol and instruction text inside the prompt
- future memory and RAG candidate estimates

The calculator enforces the provider-reported context window first, then the guaranteed window, then the advertised window. Output reserve is capped at 25 percent of the enforced context window so models with very large reported output ceilings still retain a usable input budget.

## Compaction Decision Points

- `normal`: estimated input is below the warning threshold.
- `warn`: estimated input is at or above the warning threshold but below the compaction threshold.
- `compact`: estimated input is at or above the compaction threshold and still inside the hard input budget.
- `stop`: estimated input exceeds the hard input budget.

Pre-prompt flow:

```text
pre-prompt estimate
-> warn/compact/stop decision
-> optional session.compact()
-> recompute estimate
-> stop if still too large
-> prompt
-> post-response usage telemetry
```

Flue's own threshold and overflow compaction still run during and after the prompt. The GOROMBO layer exists to reduce provider rejections and to give RAG a real remaining-token budget before retrieved context is injected.

## RAG Allocation Rule

RAG must receive only the remaining input budget after these items are accounted for:

- session/history estimate
- system and workflow instructions
- normalized user event
- protocol context
- memory context
- output reserve

Future RAG work should ask the budget layer for remaining tokens before adding search results, document chunks, or memory summaries to the prompt.

## Open Questions

No unresolved implementation questions remain for the current in-process session budget layer. The next storage decision is whether to persist `SessionBudgetState` beside Flue `SessionStore` for multi-process deployments.
