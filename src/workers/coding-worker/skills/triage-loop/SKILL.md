# Coding Worker Triage Loop

Use this skill to classify a coding task before implementation.

- Identify whether the request is bug fix, feature, refactor, review, CI/debug, GitHub administration, or planning.
- Determine which worker-local internal subagents are needed.
- Gather only the context needed by the next subagent.
- Emit public progress and rationale events for the orchestrator.
- Do not expose raw hidden thinking or full internal prompts.

