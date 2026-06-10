# Session Context Budget

Last checked: 2026-06-10.

## Flue Session Findings

Flue sessions are named conversation state inside an initialized harness. `harness.session(name)` gets or creates a session, while `harness.sessions.get(name)` only loads an existing session and throws when it does not exist. A session runs one active `prompt`, `skill`, `task`, `shell`, or `compact` operation at a time.

Sources:

- Flue Agent API: https://flueframework.com/docs/api/agent-api/
- Flue Data Persistence API: https://flueframework.com/docs/api/data-persistence-api/
- Flue Database guide: https://flueframework.com/docs/guide/database/
- Installed runtime types: `node_modules/@flue/runtime/dist/run-registry-PAFvJO48.d.mts`
- Installed runtime implementation: `node_modules/@flue/runtime/dist/run-store-CkOkvOxX.mjs`

Flue persists session state through the configured `PersistenceAdapter`. On Node, the current Flue persistence entrypoint is a source-root `src/db.ts` file that exports an adapter such as `sqlite('./data/flue.db')`. Without `db.ts`, the Node target uses in-memory state that disappears when the process exits. `SessionData` is version 5 and contains `affinityKey`, entries, `leafId`, metadata, and timestamps.

`session.prompt(...)` appends the user prompt to the active session and runs against the session's current conversation context. The runtime rebuilds the agent harness state from stored session history when opening a session, then syncs newly produced messages back into session history after each prompt.

`PromptResponse.usage` is post-call telemetry. Flue aggregates token and cost usage across model work performed by one `prompt`, `skill`, or `task` call. The installed runtime also folds compaction summarization usage into the operation that triggered compaction.

Flue exposes compaction in two ways:

- Agent config accepts `compaction: false | CompactionConfig`.
- `session.compact()` triggers compaction immediately and resolves without work when there is nothing to compact.

`CompactionConfig` has `reserveTokens`, `keepRecentTokens`, and `model`. Flue automatic threshold compaction triggers when the current context token count is greater than `contextWindow - reserveTokens`. The installed runtime estimates context with provider usage from the latest assistant message plus a character-count estimate for trailing messages. It also has overflow recovery that compacts and retries after a provider context overflow.

Flue does not expose a public pre-prompt exact token count for application code in the installed `@flue/runtime` package. GOROMBO owns the pre-prompt budget layer by estimating the next prompt and the persisted session context before calling `session.prompt(...)`.

## Implemented GOROMBO Layer

The active runtime model card now drives context budgeting, backup failover, and compaction:

- `src/models/catalog.ts` resolves a Flue model specifier to a project-owned model card from provider-owned card directories.
- the shipped `gorombo.config.json` runtime file selects the primary model card and optional backup model card for the deployment.
- `src/session/context-budget.ts` calculates enforced context, output reserve, usable input, warning threshold, compaction threshold, and hard-stop threshold.
- `src/session/compaction-policy.ts` converts token estimates into `normal`, `warn`, `compact`, or `stop`.
- `src/db.ts` exports the Flue persistence adapter discovered by Flue at build time.
- `src/session/session-persistence.ts` wraps Flue's built-in SQLite adapter through the public `PersistenceAdapter` contract.
- `src/session/session-database.ts` stores GOROMBO session catalog, active-session routing, logical Flue session indexes, and extracted session-memory FTS records.
- `src/session/flue-session-store.ts` contains Flue session-key helpers only.
- `src/session/session-budget.ts` derives budget state from stored Flue `SessionData` and keeps an in-process fallback ledger for cases where session data is unavailable.
- `src/workflows/chat.ts` evaluates the next prompt before calling `session.prompt(...)`.
- `src/agents/orchestrator.ts` passes card-derived Flue compaction settings to `createAgent(...)`; it does not pass persistence. Persistence belongs to `src/db.ts`.

Flue remains the owner of canonical `SessionData`. The GOROMBO wrapper indexes latest data by logical harness/session name so the synchronous chat workflow can recover the latest `gorombo-orchestrator` conversation state even when a workflow invocation receives a new Flue run id.

The chat workflow sequence is:

```text
normalize message
-> resolve product session and pre-LLM slash commands
-> initialize orchestrator using Flue db.ts persistence
-> load latest logical Flue SessionData
-> resolve primary and backup model cards from runtime config
-> estimate session history plus next prompt
-> warn, compact, or stop
-> call session.compact() when compaction is required
-> refuse the prompt when the hard input budget is still exceeded
-> session.prompt(..., primary model card)
-> retry same session with backup model card when the primary model/provider is recoverably unavailable
-> read updated Flue SessionData
-> return contextBudget telemetry
```

This keeps Flue's native automatic compaction enabled and adds a GOROMBO pre-send guard before the provider receives an oversized prompt.

## Persistence And Session Memory Boundary

`src/db.ts` is the Flue persistence boundary. `src/session/session-database.ts` is the GOROMBO sidecar index for product session records and extracted session-memory retrieval.

Current behavior:

- Implements Flue's public `PersistenceAdapter` contract by wrapping Flue's built-in SQLite adapter.
- Saves and loads exact Flue `SessionData` through Flue's SQLite session store.
- Stores workflow run metadata and run registry lookups in SQLite for the Flue run API.
- Rebuilds protected telemetry summaries from persisted Flue run event streams when in-memory observer summaries are gone.
- Parses Flue storage keys shaped as `agent-session:[instanceId,harnessName,sessionName]`.
- Indexes the latest session by `harnessName + sessionName` so chat continuity can survive workflow run id changes.
- Exposes `getLatestSessionData(harnessName, sessionName)` for budget derivation.
- Extracts message, compaction, and branch-summary text into `session_memory_fts` for session-memory retrieval.

The SQLite implementation stores:

- Flue-owned canonical runtime data in `.gorombo/db/flue.sqlite`
- workflow run records, run registry records, and Flue event streams in `.gorombo/db/flue.sqlite`
- GOROMBO chat session records in `.gorombo/db/sessions.sqlite`
- active connector session pointers
- logical Flue session indexes
- session-memory FTS chunks extracted from Flue `SessionData`

Session memory does not fork conversation truth into a separate transcript. It indexes text extracted from Flue `SessionData` and returns matching chunks through the memory tool. The future seven-layer GOROMBO memory stack remains separate from this session-memory layer.

## Budget Inputs

- primary model card
- backup model card
- active model card for the current prompt attempt
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

Backup model failover is an availability path, not a way to bypass context budgeting. If the primary model fails with a recoverable provider/model availability error, the chat workflow checks the backup card's budget and retries with the backup specifier on the same Flue session. Context-length errors, aborts, and hard-stop budget failures do not trigger a backup retry.

## RAG Allocation Rule

RAG must receive only the remaining input budget after these items are accounted for:

- session/history estimate
- system and workflow instructions
- normalized user event
- protocol context
- memory context
- output reserve

RAG asks the budget layer for remaining tokens before adding search results, document chunks, or memory summaries to the prompt. Web search enters through the researcher-owned `web-research` workflow, which uses the retrieval workflow as lower-level machinery. Returned snippets and fetched pages are packed to the configured retrieval budget before they are returned to the researcher. Ollama Search is the default web provider because it uses the existing Ollama API key already needed for cloud model testing.

Current retrieval controls:

- `maxContextTokens`: per-call returned-context budget
- `GOROMBO_RAG_MAX_CONTEXT_TOKENS`: default returned-context budget when the call does not provide one
- `webFetch`: `auto`, `always`, or `never`
- `GOROMBO_RAG_WEB_FETCH_TOP_K`: default number of top web results to expand through fetch
- `metadata.providerFailures`: non-fatal provider errors, including search outages or authentication failures

The `researcher` subagent uses these controls through `web_research`. This keeps context packing and provider failures in workflow machinery while preserving the ownership boundary: the orchestrator delegates web/current/source-backed work to the researcher, and the researcher owns web search decisions.

## Slash Commands

Slash commands are parsed before the LLM receives the prompt:

- `/new` creates a new session for connector-style entrypoints and is disabled inside web chat prompts because the web UI should switch visual session state through a client-side new-chat action.
- `/compact` calls `session.compact()` for the resolved Flue session and returns command telemetry without sending `/compact` to the model.

Future commands can accept trailing instruction text through the same parser. Unsupported slash commands are handled by application code and are not sent to the LLM.
