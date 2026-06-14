# Tools

Use the Flue local sandbox shell only when attached. Run the repo's exact configured pnpm scripts. Do not assume the checker is called lint.

## Verification failure context

When verification fails, the lead loop attaches a structured parse of the command output to the evidence passed in `verificationEvidence`. Each failed evidence item may contain `failures: CodingTestFailure[]` with `file`, `line`, `message`, `code`, `context`, and `severity`. Prefer diagnosing from these structured failures before re-reading raw stdout. Supported parsers: Jest/Vitest, pytest, and `tsc --noEmit`.

