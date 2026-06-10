# Persona Workspace Tracking

## Purpose

Track the persona workspace design for GOROMBO agents so decisions survive context compaction and future phase work.

## Current Context

- This project is a Flue-based agent system.
- Each agent is expected to have its own workspace.
- Subagents are built like normal agents and can have their own workspace files.
- The first two agents that need persona workspaces are the main orchestrator and the researcher.
- The main orchestrator should remain a coordinator that routes, loads protocols, retrieves safe memory when useful, delegates to subagents, validates, and synthesizes.
- The researcher owns web/current/source-backed research.
- Persona workspace files are loaded explicitly by the project persona loader, not by relying on Flue workspace auto-discovery.
- Flue may still load `AGENTS.md` from the actual session working directory.

## Persona File Contract

Required initial files:

- `SOUL.md` - personality, tone, boundaries, and continuity.
- `IDENTITY.md` - agent name, role, details, and presentation metadata.
- `AGENTS.md` - agent-level operating rules.
- `USER.md` - personal context about the user.
- `TOOLS.md` - environment and capability notes for this agent.
- `MEMORY.md` - curated long-term facts and durable project context.
- `HEARTBEAT.md` - scheduled or recurring task notes.
- `SECURITY.md` - agent-level security and safety rules.

## Open Questions

1. Should `SECURITY.md` be loaded before `AGENTS.md` so safety outranks operating style?
   - Status: Answered
   - Answer: Yes. Load `SECURITY.md` before `AGENTS.md` so security policy outranks operating style.

2. Should `MEMORY.md` be injected every time for the main agent, or should it stay behind the existing `retrieve_memory` tool except for a short bootstrap section?
   - Status: Needs discussion
   - Answer:

3. Do we want the main persona to sound like "GOROMBO" as a named assistant, or stay mostly invisible as a routing orchestrator?
   - Status: Partially answered
   - Answer: The main agent is an AI employee, usually named by the user. It should not be named after the company by default. Its persona depends on the employee role, such as personal assistant, sales team manager, production manager, technical employee, or another user-defined role.

4. Should `HEARTBEAT.md` be created empty now, or should we leave it out until scheduled tasks exist?
   - Status: Answered
   - Answer: Create it now with placeholder definitions and an example.

5. Where should the directory shape live?
   - Status: Answered
   - Answer: The main agent workspace lives at `src/workspace/`. Subagent implementations live under `src/workers/<name>/`, and each subagent workspace lives at `src/workers/<name>/workspace/`.

6. What is the product/system name for this OpenClaw replacement?
   - Status: Answered
   - Answer: Working name is SIM-ONE Alpha.

7. What employee role is the first main agent workspace for?
   - Status: Answered
   - Answer: The first main agent is Ollie, personal assistant for Daniel T Sasser II, founder and CEO of Gorombo. Ollie helps with CEO-assistant work including email management, coding projects, delegation to other agents, coordination, and any broad executive-support tasks a CEO needs.

8. Should `TOOLS.md` include only currently wired tools, or also planned tools?
   - Status: Answered
   - Answer: It can contain currently wired tools and grow as tools are added. It may include examples for likely future tools, such as GitHub, when usage is known and clearly framed.

9. Should user-editable persona files be shipped as defaults in source, copied into a runtime workspace, or edited directly in place?
   - Status: Needs explanation
   - Answer:

10. For subagents, should `USER.md` describe the main agent they serve, the end human/company, or both?
   - Status: Answered
   - Answer: Both, but context-conservatively. The subagent should understand its direct principal is the main agent it serves, while also knowing there is a human/company above that main agent when relevant.

11. Should `SECURITY.md` remain prompt-level guidance for now, or should this phase design enforceable policy wrappers?
   - Status: Answered
   - Answer: Keep it as prompt-level guidance for now.

12. Do we want `BOOT.md` and `BOOTSTRAP.md` in the initial file contract?
   - Status: Answered
   - Answer: No. The project will likely handle those concerns differently later.

## Discussion Notes

### 2026-06-09

- The persona workspace idea follows the OpenClaw-style agent workspace model, adapted for SIM-ONE Alpha and Flue.
- SIM-ONE Alpha adds `SECURITY.md` as a first-class persona workspace file.
- The persona workspace should not accidentally replace the Protocol System.
- Protocols remain SQLite-backed runtime directives loaded through the Protocol Tool.
- Persona files become baseline identity, context, and operating instructions for each agent.
- For the main orchestrator, the initial hardcoded prompt in `src/agents/orchestrator.ts` should eventually be split across the persona workspace files.
- `TOOLS.md` remains part of the agent workspace. It should guide the agent on when to use available tools, local conventions, ownership boundaries, and specific usage patterns, without replacing Flue tool definitions.
- Flue tool files remain the implementation and model-facing schema boundary for tools: tool name, description, parameters, and execution behavior.
- `SECURITY.md` has a different purpose from `TOOLS.md`: it defines agent-level tool-use security policy, restrictions, and approval requirements.
- Example security use case: an MCP email-sending tool can be available to an agent, while `SECURITY.md` requires an approval/security alert before the tool is actually used.
- Main agents are AI employees. They represent product-facing employee personas such as personal assistants, sales team managers, production managers, technical employees, or other user-defined roles.
- Subagents are built like normal agents and also receive workspace persona files. Their identities are usually more specialized than the main agent's identity.
- Subagents should usually receive mythological names that fit their function, such as an image-making agent named after a mythological craft figure.
- `IDENTITY.md` and `SOUL.md` help both main agents and subagents understand who they are and what kind of work they are meant to do.
- `USER.md` means "who this agent works for." For a main AI employee, `USER.md` describes the human or organization it serves. For a subagent, `USER.md` describes the main agent it serves, because the main agent is the subagent's direct principal.
- The product/system working name is SIM-ONE Alpha. It is the Flue-based replacement for the current OpenClaw-supported AI employee layer.
- The first main agent is Ollie, a personal assistant AI employee for Daniel T Sasser II, founder and CEO of Gorombo.
- A future company signature file is expected. It should explain the company, but it should not be conflated with `USER.md` because the first Ollie `USER.md` will already include Daniel and company-specific context.
- Initial contract excludes `BOOT.md` and `BOOTSTRAP.md`.
