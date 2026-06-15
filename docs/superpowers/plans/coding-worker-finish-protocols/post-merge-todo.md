# Protocol Phase 1 — Post-Merge TODO

## Item: Deterministic protocol loading at the orchestrator level

**Status:** Open, requires Flue runtime support or architectural change.

**Context:**
PR #23 wires protocol loading through the `load_protocols` tool and instructs the orchestrator to call it before reasoning and to pass the resulting `ProtocolBundle` into `coding-worker` task input. However, this is currently enforced by prompt instructions only. There is no host-level guarantee that `load_protocols` is invoked before tool use, reasoning, delegation, or response generation.

**Why we did not implement it in PR #23:**
The Flue `createAgent()` runtime does not expose an agent-loop hook, pre-tool hook, pre-delegation hook, or deterministic middleware for a created agent's reasoning loop. The `route` export is Hono HTTP middleware, not an agent-behavior interceptor. Therefore, the only deterministic control points Flue currently provides are:

- Attaching a tool (which we did: `load_protocols`).
- Instructing the model in the system prompt (which we did).
- Replacing direct agent dispatch with a workflow that orchestrates the call chain (possible, but changes the ingress architecture and is outside Phase 1 scope).

**Options to address in the future:**

1. **Flue runtime feature request:** ask the Astro/Flue team for a `beforeTurn` / `beforeTool` / `beforeDelegate` agent hook, or a "system tool" that is automatically invoked on every agent invocation before any model reasoning.

2. **Workflow ingress:** change chat-event ingress so that incoming events enter a Flue workflow instead of the orchestrator directly. The workflow deterministically calls `load_protocols`, parses the bundle, and then dispatches to the orchestrator with `protocolBundle` already present in the payload. The orchestrator then has the bundle as payload context and cannot avoid it.

3. **Deterministic router agent:** replace the chat-orchestrator with a thin deterministic router that loads protocols and then explicitly branches to researcher/coding-worker. This is a bigger architectural change.

**Recommended next step:**
Open a follow-up issue/discussion with the Flue maintainers to determine whether there is an intended pattern for deterministic host-level agent behavior. Do not implement ad-hoc wrappers around the orchestrator; any solution should be idiomatic to Flue.
