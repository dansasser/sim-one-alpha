# Orchestrator Flow

Phase 1 builds the base orchestrator system only.

The flow is intentionally simple and testable:

```text
Connector
-> NormalizedMessageEvent
-> Secure Web API / Gateway
-> Orchestrator
-> Protocol Provider
-> RAG Router
-> Memory / Web Search / Document Index providers
-> OrchestratorResponse
```

The orchestrator must load protocols before it performs final routing or response synthesis. Current providers are typed placeholders so the system can route a basic chat message without real external credentials.

The first response path does not call a live model. It proves the architecture can normalize an event, load protocol directives, retrieve context through the RAG architecture, and return a structured response.

