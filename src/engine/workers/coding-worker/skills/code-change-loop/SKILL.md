# Coding Worker Code Change Loop

Use this skill for scoped implementation work.

- Start from the accepted plan and repo preflight.
- Use the Flue local sandbox for trusted file, shell, git, and test actions.
- Keep edits scoped to the task.
- Return exact-text edits and file writes as a `CodingEditTransaction`.
- Apply edits atomically: all operations validate first, then apply together, rolling back on the first failure.
- Binary files and missing patch targets are rejected before any file is mutated.
- Run focused verification before broad verification.
- Return structured evidence, changed-file summaries, and remaining risks.

