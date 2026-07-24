# Orchestrator Flow

The orchestration flow:

```text
Connector
-> NormalizedMessageEvent
-> Secure Web API / Gateway
-> Durable Flue orchestrator agent session
-> Orchestrator
-> Protocol Provider
-> RAG Router
-> Memory / Web Search / Document Index providers
-> OrchestratorResponse
```

The orchestrator must load protocols before it performs final routing or response synthesis. The app-owned chat path persists normalized event context, resolves the product session, and prompts the durable `orchestrator` agent instance for that session. The orchestrator delegates web/current/source-backed research to the researcher subagent.

HTTP workflow invocation remains available for finite workflows. Workflow calls return a Flue run pointer first, and clients read the run result through the protected `/runs/:runId` route. Direct orchestrator prompts and dispatched agent input are not workflow runs.

The SIM-ONE terminal interface enters this same durable chat path through `/api/chat/events` as connector `tui`.
