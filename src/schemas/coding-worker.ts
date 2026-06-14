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

export const CodingPlanItemSchema = v.object({
  id: v.string(),
  description: v.string(),
  owner: v.union([
    v.literal('triage'),
    v.literal('implementer'),
    v.literal('test-debug'),
    v.literal('code-review'),
    v.literal('github'),
    v.literal('coding-worker'),
  ]),
  status: v.union([v.literal('pending'), v.literal('in_progress'), v.literal('completed'), v.literal('blocked')]),
});

export type CodingPlanItem = v.InferOutput<typeof CodingPlanItemSchema>;

export const CodingTriageResultSchema = v.object({
  plan: v.array(CodingPlanItemSchema),
  filesToInspect: v.array(v.string()),
  recommendedExecutionPath: v.union([
    v.literal('implementer'),
    v.literal('github'),
    v.literal('test-debug'),
    v.literal('code-review'),
    v.literal('manual'),
  ]),
});

export type CodingTriageResult = v.InferOutput<typeof CodingTriageResultSchema>;

export const CodingTestDebugResultSchema = v.object({
  debugEdits: v.array(CodingFileEditSchema),
  verificationCommands: v.array(CodingVerificationCommandRequestSchema),
  analysis: v.string(),
});

export type CodingTestDebugResult = v.InferOutput<typeof CodingTestDebugResultSchema>;

export const CodingCodeReviewFindingSchema = v.object({
  file: v.optional(v.string()),
  lineStart: v.optional(v.number()),
  lineEnd: v.optional(v.number()),
  severity: v.union([v.literal('info'), v.literal('warning'), v.literal('blocker')]),
  message: v.string(),
});

export type CodingCodeReviewFinding = v.InferOutput<typeof CodingCodeReviewFindingSchema>;

export const CodingCodeReviewResultSchema = v.object({
  findings: v.array(CodingCodeReviewFindingSchema),
  approved: v.boolean(),
});

export type CodingCodeReviewResult = v.InferOutput<typeof CodingCodeReviewResultSchema>;

export const CodingGithubActionSchema = v.object({
  action: v.union([
    v.literal('comment'),
    v.literal('create_pr'),
    v.literal('update_pr'),
    v.literal('merge_pr'),
    v.literal('close_pr'),
  ]),
  payload: v.record(v.string(), v.unknown()),
});

export type CodingGithubAction = v.InferOutput<typeof CodingGithubActionSchema>;

export const CodingGithubResultSchema = v.object({
  actions: v.array(CodingGithubActionSchema),
});

export type CodingGithubResult = v.InferOutput<typeof CodingGithubResultSchema>;
