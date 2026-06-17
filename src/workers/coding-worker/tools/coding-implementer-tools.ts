import { defineTool, type ToolDefinition } from '@flue/runtime';
import * as v from 'valibot';
import { CodingImplementerResultSchema } from '../../../schemas/coding-worker.js';

export function createCodingImplementerTools(): ToolDefinition[] {
  return [
    defineTool({
      name: 'coding_implementer_submit_result',
      description:
        'Submit the final structured implementation result containing file edits, files written, and commands needed to verify them. The result must match the CodingImplementerResult schema exactly; invalid submissions will be rejected.',
      parameters: v.object({
        fileEdits: v.array(
          v.object({
            path: v.string(),
            oldText: v.string(),
            newText: v.string(),
            expectedOccurrences: v.optional(v.number()),
          })
        ),
        writeFiles: v.array(
          v.object({
            path: v.string(),
            content: v.string(),
          })
        ),
        verificationCommands: v.array(
          v.object({
            name: v.string(),
            command: v.string(),
            required: v.optional(v.boolean()),
            reason: v.optional(v.string()),
            cwd: v.optional(v.string()),
            timeoutSeconds: v.optional(v.number()),
          })
        ),
      }),
      execute: async (args) => {
        const result = v.parse(CodingImplementerResultSchema, args);
        return JSON.stringify({ status: 'submitted', result }, null, 2);
      },
    }),
  ];
}
