import * as v from 'valibot';

/**
 * Exact text edit applied by the coding worker.
 *
 * When `expectedOccurrences` is omitted, every occurrence of `oldText` is
 * replaced. Set `expectedOccurrences` when callers need a strict occurrence
 * count guard before replacement.
 */
export const CodingFileEditSchema = v.object({
  path: v.string(),
  oldText: v.string(),
  newText: v.string(),
  expectedOccurrences: v.optional(v.number()),
});

export type CodingFileEdit = v.InferOutput<typeof CodingFileEditSchema>;

export const CodingFileWriteSchema = v.object({
  path: v.string(),
  content: v.string(),
});

export type CodingFileWrite = v.InferOutput<typeof CodingFileWriteSchema>;

export const CodingVerificationCommandRequestSchema = v.object({
  name: v.string(),
  command: v.string(),
  required: v.optional(v.boolean()),
  reason: v.optional(v.string()),
  cwd: v.optional(v.string()),
  timeoutSeconds: v.optional(v.number()),
});

export type CodingVerificationCommandRequest = v.InferOutput<typeof CodingVerificationCommandRequestSchema>;

/**
 * Structured output returned by the coding-worker implementer subagent.
 *
 * This schema is used both to validate the implementer's submitted result and
 * to type the structured response returned by Flue when the implementer is
 * delegated via `session.task(..., { result: CodingImplementerResultSchema })`.
 */
export const CodingImplementerResultSchema = v.object({
  fileEdits: v.array(CodingFileEditSchema),
  writeFiles: v.array(CodingFileWriteSchema),
  verificationCommands: v.array(CodingVerificationCommandRequestSchema),
});

export type CodingImplementerResult = v.InferOutput<typeof CodingImplementerResultSchema>;
