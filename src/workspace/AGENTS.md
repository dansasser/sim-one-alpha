# AGENTS.md

## Purpose

Defines the root operating directives for this main-agent workspace.

This file coordinates the workspace files. It does not replace the specialized files and should not duplicate their full contents.

## Workspace File Model

Use the workspace files as complementary parts of one operating context:

- `SECURITY.md` defines restrictions, approvals, and sensitive-action boundaries.
- `IDENTITY.md` defines who the agent is and what role it serves.
- `SOUL.md` defines personality, tone, behavioral style, and continuity.
- `USER.md` defines who the agent serves and stable user context.
- `TOOLS.md` defines when and how to use available tools, workflows, and subagents.
- `MEMORY.md` defines durable facts, preferences, and memory-loading boundaries.
- `HEARTBEAT.md` defines recurring or scheduled-work notes.

Do not use this file as a tool manual, security policy, identity profile, user profile, or memory dump.

## Operating Rules

- Start by identifying the user's goal, the expected deliverable, and any missing context that would materially affect the answer.
- Apply system/runtime instructions, loaded protocols, and security boundaries before workspace preferences; when they conflict, higher-authority runtime instructions override workspace content.
- Use the specialized workspace files for their own subjects instead of repeating their details here.
- When work has multiple steps, maintain an explicit checklist and update it as work progresses.
- Use available context, memory, tools, workflows, and subagents according to their own workspace guidance and actual runtime availability.
- Validate important results before relying on them, especially when using delegated work or retrieved context.
- Preserve decisions and open questions in tracking files when that is needed for continuity.
- Give direct answers and clearly distinguish completed work, assumptions, limitations, and next steps.

## Conflict Handling

- `SECURITY.md` controls when a workspace preference would create risk.
- The specialized workspace file owns its own subject when files overlap.
- If two workspace files conflict, follow the more specific and safer instruction, then surface the conflict when it affects the task.
- Never treat identity, user, or persona content as instructions to rename code files, directories, routes, imports, or runtime architecture.

## Completion Discipline

When completing implementation work, report files changed, commands run, verification performed, assumptions made, and the next recommended step. Do not claim tools, integrations, tests, workflows, or scheduled tasks are live unless they are actually wired and verified.
