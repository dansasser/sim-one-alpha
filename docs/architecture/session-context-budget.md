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

Flue persists session state through the configured `PersistenceAdapter`. On Node, the current Flue persistence entrypoint is a source-root `src/core/db.ts` file that exports an adapter such as `sqlite('./data/flue.db')`. Without `db.ts`, the Node target uses in-memory state that disappears when the process exits. `SessionData` is version 5 and contains `affinityKey`, entries, `leafId`, metadata, and timestamps.

`session.prompt(...)` appends the user prompt to the active session and runs against the session's current conversation context. The runtime rebuilds the agent harness state from stored session history when opening a session, then syncs newly produced messages back into session history after each prompt.

`PromptResponse.usage` is post-call telemetry. Flue aggregates token and cost usage across model work performed by one `prompt`, `skill`, or `task` call. The installed runtime also folds compaction summarization usage into the operation that triggered compaction.

Flue exposes compaction in two ways:

- Agent config accepts `compaction: false | CompactionConfig`.
- `session.compact()` triggers compaction immediately and resolves without work when there is nothing to compact.

`CompactionConfig` has `reserveTokens`, `keepRecentTokens`, and `model`. Flue automatic threshold compaction triggers when the current context token count is greater than `contextWindow - reserveTokens`. The installed runtime estimates context with provider usage from the latest assistant message plus a character-count estimate for trailing messages. It also has overflow recovery that compacts and retries after a provider context overflow.

Flue does not expose a public pre-prompt exact token count for application code in the installed `@flue/runtime` package. SIM-ONE Alpha owns the pre-prompt budget layer by estimating the next prompt and the persisted session context before calling `session.prompt(...)`.

## Implemented SIM-ONE Alpha Layer

The active runtime model card now drives context budgeting and compaction:

- `src/core/models/catalog.ts` resolves a Flue model specifier to a project-owned model card from provider-owned card directories.
- the shipped `gorombo.config.json` runtime file selects the primary model card and optional backup model card for the deployment.
- `src/engine/session/context-budget.ts` calculates enforced context, output reserve, usable input, warning threshold, compaction threshold, and hard-stop threshold.
- `src/engine/session/compaction-policy.ts` converts token estimates into `normal`, `warn`, `compact`, or `stop`.
- `src/core/db.ts` exports the Flue persistence adapter discovered by Flue at build time.
- `src/engine/session/session-persistence.ts` wraps Flue's built-in SQLite adapter through the public `PersistenceAdapter` contract.
- `src/engine/session/session-database.ts` stores SIM-ONE Alpha session catalog, active-session routing, logical Flue session indexes, durable direct-agent instance indexes, normalized event context, and extracted session-memory FTS records.
- `src/engine/session/flue-session-store.ts` contains Flue session-key helpers only.
- `src/engine/session/session-budget.ts` derives budget state from stored Flue `SessionData` and keeps an in-process fallback ledger for cases where session data is unavailable.
- `src/api/routes/chat-events.ts` owns HTTP chat ingress and opens durable direct-agent sessions for slash commands.
- `src/api/routes/chat-events.ts` is the primary app-owned chat ingress. It persists normalized event context and prompts `/agents/orchestrator/:sessionId?wait=result` so normal chat enters Flue's durable agent submission lifecycle.
- `src/engine/agents/orchestrator.ts` passes card-derived Flue compaction settings to `createAgent(...)`; it does not pass persistence. Persistence belongs to `src/core/db.ts`.

Flue remains the owner of canonical `SessionData`. The SIM-ONE Alpha wrapper indexes latest data by logical harness/session name for workflows and by instance/harness/session identity for durable direct-agent sessions.

The durable chat ingress sequence is:

```text
normalize message
-> resolve product session and pre-LLM slash commands
-> persist normalized event context
-> call the durable /agents/orchestrator/:sessionId route for normal prompts
-> Flue admits the prompt into durable direct-agent submission storage
-> store updated Flue SessionData through the persistence adapter
-> index session memory chunks
```

This keeps Flue's native automatic compaction enabled on the durable direct-agent path. Explicit `/compact` opens the same durable direct-agent session and calls `session.compact()` without sending the command text to the model.

## Persistence And Session Memory Boundary

`src/core/db.ts` is the Flue persistence boundary. `src/engine/session/session-database.ts` is the SIM-ONE Alpha sidecar index for product session records and extracted session-memory retrieval.

Current behavior:

- Implements Flue's public `PersistenceAdapter` contract by wrapping Flue's built-in SQLite adapter.
- Saves and loads exact Flue `SessionData` through Flue's SQLite session store.
- Stores workflow run metadata and run registry lookups in SQLite for the Flue run API.
- Rebuilds protected telemetry summaries from persisted Flue run event streams when in-memory observer summaries are gone.
- Parses Flue storage keys shaped as `agent-session:[instanceId,harnessName,sessionName]`.
- Indexes the latest workflow session by `harnessName + sessionName` so finite workflow continuity can survive workflow run id changes.
- Indexes durable direct-agent sessions by `instanceId + harnessName + sessionName` so separate orchestrator agent instances do not collapse into one logical `default/default` session.
- Persists normalized message event context before durable agent admission so protocol and memory tools can recover trusted selectors after process restart.
- Exposes `getLatestSessionData(harnessName, sessionName)` for budget derivation.
- Extracts message, compaction, and branch-summary text into `session_memory_fts` for session-memory retrieval.

The SQLite implementation stores:

- Flue-owned canonical runtime data in `.gorombo/db/flue.sqlite`
- workflow run records, run registry records, and Flue event streams in `.gorombo/db/flue.sqlite`
- AI employee chat session records in `.gorombo/db/sessions.sqlite`
- active connector session pointers
- logical Flue session indexes
- direct Flue agent instance indexes
- normalized message event context for protocol and memory lookup
- session-memory FTS chunks extracted from Flue `SessionData`

Session memory does not fork conversation truth into a separate transcript. It indexes text extracted from Flue `SessionData` and returns matching chunks through the memory tool. The future seven-layer SIM-ONE Alpha memory stack remains separate from this session-memory layer.

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

Compaction flow:

```text
durable direct-agent session
-> native Flue threshold and overflow compaction during prompt work
-> explicit /compact when the user or client requests compaction
-> session.compact()
-> persisted SessionData and session-memory index update
```

Flue's own threshold and overflow compaction still run during and after the prompt. The SIM-ONE Alpha layer keeps the budget data available so RAG can receive a real remaining-token budget before retrieved context is injected.

Backup model failover is an availability path, not a way to bypass context budgeting. Current durable chat execution uses the primary configured card; backup cards remain configured metadata for future fallback-capable paths.

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

- `/new` creates a new session for trusted connector-style and TUI entrypoints. It is disabled for GUI-managed web chat prompts because the web UI should switch visual session state through a client-side new-chat action. Generic Web API payloads must not be able to opt into connector-only behavior by spoofing a connector name.
- `/compact` calls `session.compact()` for the resolved durable direct-agent Flue session and returns command telemetry without sending `/compact` to the model.

Future commands can accept trailing instruction text through the same parser. Unsupported slash commands are handled by application code and are not sent to the LLM.
