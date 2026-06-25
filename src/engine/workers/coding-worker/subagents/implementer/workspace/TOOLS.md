# Tools

Use Flue local sandbox file and shell capabilities only when they are actually available in the child session. Do not perform GitHub side effects.

When you have finalized your code edits, you must use the `coding_implementer_submit_result` tool to report the `CodingFileEdit`s, files written, and verification commands required to validate your work to the coding-worker lead.

## Structured Submission

Your final response must be a validated `CodingImplementerResult` submitted through `coding_implementer_submit_result`. It contains three arrays:

- `fileEdits`: exact text replacements for existing files. Each edit is a `CodingFileEdit` with `path`, `oldText`, `newText`, and optional `expectedOccurrences`.
- `writeFiles`: complete file contents for new files. Each entry is `{ path, content }`.
- `verificationCommands`: focused commands that prove the change works. Each entry is `{ name, command, required?, reason?, cwd?, timeoutSeconds? }`.

The lead validates the submitted result against the `CodingImplementerResult` schema. Invalid submissions are rejected, so keep the shape exact.

## Exact Text Edits

When making file edits using `coding_repo_apply_patch` / `coding_repo_apply_exact_edit` or when returning file edits via `coding_implementer_submit_result`, ensure your exact text replacements are robust.

### Choosing `oldText`

- `oldText` must match the file content exactly, including whitespace, indentation, and line endings.
- Prefer a focused, stable snippet over a long block. A good `oldText` is unique enough to match unambiguously but short enough that formatting drift does not break it.
- Include surrounding context when needed to make the match unique, but avoid spanning large blocks that are likely to change in unrelated ways.
- Read the file with `coding_repo_read_file` first so you know the exact bytes in the workspace.

### Line and Whitespace Handling

- Preserve the original indentation in `newText`. The replacement is literal: the runtime does not re-indent for you.
- Use the same line-ending style as the file (`\n` vs `\r\n`).
- When replacing a single line, include the trailing newline if you want the next line to stay aligned.
- Trailing spaces and tabs matter; copy them exactly from the source.

### `expectedOccurrences`

- Omit `expectedOccurrences` to replace every occurrence of `oldText` in the file.
- Set `expectedOccurrences: 1` when the edit must match exactly one location. This is the safest default for focused changes.
- If `oldText` appears more often than you expect, the patch fails and you can refine `oldText` with more context.
- When a multi-location replacement is intentional, omit `expectedOccurrences` or set it to the known count.

### Applying Edits Before Submission

You may use `coding_repo_apply_patch` or `coding_repo_apply_exact_edit` to apply and verify edits inside the sandbox before building your final `coding_implementer_submit_result`.

- `coding_repo_apply_patch`: apply multiple edits to one file in a single call. It returns the applied `CodingFileEdit[]` array with `path`, `status`, and `replacements`.
- `coding_repo_apply_exact_edit`: apply a single `CodingFileEdit` to one file. It returns the applied edit object.
- Use the returned edit objects to populate `fileEdits` in `coding_implementer_submit_result`, ensuring `path`, `oldText`, and `newText` are correct.

## Verification Commands

Choose focused commands that exercise the change you just made.

- Prefer the smallest command that proves the edit is correct (e.g., a single unit test, a typecheck, or a targeted script).
- Set `required: true` for commands that must pass before the task can complete.
- Provide a clear `reason` explaining what the command validates.
- Use `cwd` only when the command must run in a different directory than the default workspace scope.
- Use `timeoutSeconds` to cap long-running checks; the default is 120 seconds.

## Final Submit Tool

After reading, editing, and verifying:

1. Build the final `CodingImplementerResult` with complete `fileEdits`, `writeFiles`, and `verificationCommands`.
2. Call `coding_implementer_submit_result` with that object.
3. Do not include extra narrative outside the tool call; the structured result is your deliverable.
