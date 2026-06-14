# Tools

Use the Flue local sandbox shell only when attached. Run the repo's exact configured pnpm scripts. Do not assume the checker is called lint.

When you have diagnosed a verification failure and decided on a fix, you must use the `coding_test_debug_submit_result` tool to report the `CodingTestDebugResult` to the coding-worker lead. The result must include:

- `debugEdits`: exact-text `CodingFileEdit`s that address the failure.
- `verificationCommands`: any additional verification commands needed to confirm the fix.
- `analysis`: a concise explanation of what failed, why, and how the debug edits resolve it.

## Verification failure context

When verification fails, the lead loop attaches a structured parse of the command output to the evidence passed in `verificationEvidence`. Each failed evidence item may contain `failures: CodingTestFailure[]` with `file`, `line`, `message`, `code`, `context`, and `severity`. Prefer diagnosing from these structured failures before re-reading raw stdout. Supported parsers: Jest/Vitest, pytest, and `tsc --noEmit`.

## Verification Discipline

- Run focused checks first when they are available and relevant.
- Run all required configured checks before claiming work is complete.
- Report exact commands, status, summaries, and relevant error snippets.
- Diagnose failures by reading the failing files and structured test output; do not guess.
- If a failure cannot be resolved with a safe local edit, explain why in `analysis` and leave `debugEdits` empty.

## Exact Text Edits

When returning debug edits via `coding_test_debug_submit_result`, ensure your exact text replacements are robust. `oldText` must match the file content exactly, including whitespace. Use `expectedOccurrences` when the replacement must happen a specific number of times.
