import * as v from 'valibot';

/** Parse with Valibot and throw on any issue (used by schema unit tests). */
export function parseOrThrow<TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
  schema: TSchema,
  input: unknown,
): v.InferOutput<TSchema> {
  const result = v.safeParse(schema, input);
  if (result.issues && result.issues.length > 0) {
    const detail = result.issues
      .map((issue) => `${issue.kind}:${issue.type ?? 'unknown'} ${issue.message}`)
      .join(' | ');
    throw new Error(`parse failed: ${detail}`);
  }
  return result.output as v.InferOutput<TSchema>;
}
