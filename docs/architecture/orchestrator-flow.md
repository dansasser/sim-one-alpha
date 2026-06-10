# Orchestrator Flow

Phase 1 builds the base orchestrator system only.

The flow is intentionally simple and testable:

```text
Connector
-> NormalizedMessageEvent
-> Secure Web API / Gateway
-> Flue chat workflow
-> Orchestrator
-> Protocol Provider
-> RAG Router
-> Memory / Web Search / Document Index providers
-> OrchestratorResponse
```

The orchestrator must load protocols before it performs final routing or response synthesis. The current chat path is live through the Flue `chat` workflow, which initializes the orchestrator, applies session budget checks, and delegates web/current/source-backed research to the researcher subagent.

HTTP workflow invocation returns a Flue run pointer first. Clients read the run result through the protected `/runs/:runId` route.
