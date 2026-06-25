/goal Build the first production-ready foundation of our SIM-ONE Alpha multi-purpose orchestrating agent.

Important: work incrementally. Do not try to build the entire final system in one pass. Create a clean, testable foundation first.

Architecture goal:
Build a Flue-based AI Agent similar to Open Claw that can support tools, skills, workflows, registry-driven tools, registry-driven skills, registry-driven subagents, RAG, Telegram/web/API connectors, and coding-agent workflows.

Phase 1 deliverable:
Create the base orchestrator system only.

Requirements:

1. Set up or inspect the existing project structure.
2. Create a main orchestrator agent.
3. Create basic chat workflow routing.
4. Create a clean registry abstraction for both the base and user-defined:
   - tools
   - skills
   - subagents/workers
   - protocols
5. Do not implement every real tool yet.
6. Stub registry calls with typed interfaces and placeholder implementations.
7. Add the first RAG and Memory architecture layer, not just a placeholder RAG provider.
   - Include a Memory interface.
   - Include a Memory Tool or Memory Router.
   - Include a database-backed memory provider placeholder.
   - Include a Web Search provider placeholder.
   - Include a Document Index provider placeholder based on the existing `doc-index` concept.
   - Prioritize retrieval first. Memory writing/storage behavior can be expanded later.
8. Add connector abstraction for inbound messages.
9. Add Telegram connector skeleton, but do not require real tokens.
10.   Add Secure Web API route skeleton for receiving normalized chat events.
11.   Add clear TypeScript types for:
      - AgentDefinition
      - ToolDefinition
      - SkillDefinition
      - ProtocolDefinition
      - NormalizedMessageEvent
      - OrchestratorResponse
12.   Add tests for the registry and routing logic.
13.   Add clear comments and documentation for the orchestrator flow and registry usage.
14.   Ensure the orchestrator can handle a simple chat message event and route it through the system without errors, even if all tools and protocols are placeholders.
15.   Do not implement the autonomous coding agent yet. Only create a clean placeholder structure for it.
16.   Do not implement the full protocol system yet. Only create the database schema and loading mechanism, with placeholder protocols.
17.   Read the agents.md file for more context on the overall system architecture and principles.

Implementation principle:
The orchestrator does not need to know everything. It needs to know how to use tools, registries, RAG, memory, and subagents to find what it needs.

Subagent principle:
Built-in subagents may be statically defined later, but user-added subagents should be registry-defined runtime workers. Create the interfaces for this now, but do not overbuild the worker runtime yet.

Tool principle:
Native Flue tools are build-time tools. Future dynamic tools should be accessed through a stable registry wrapper/gateway. Create the wrapper interface now.

Protocol principle:
Protocols are not skills. Protocols are stored rule sets loaded from a database or file and applied through tools.

Coding-agent note:
Do not build the full autonomous coding agent yet. Only leave a clean placeholder structure for it. It will later need plan → edit → test → debug-loop → diff → approval behavior.

Output:
When complete, summarize:

- files created
- files changed
- commands run
- tests passed/failed
- next recommended phase
