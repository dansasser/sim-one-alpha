import { defineTool, Type, type ToolDefinition } from '@flue/runtime';
import * as v from 'valibot';
import { CodingImplementerResultSchema } from '../../../schemas/coding-worker.js';

export function createCodingImplementerTools(): ToolDefinition[] {
  return [
    defineTool({
      name: 'coding_implementer_submit_result',
      description:
        'Submit the final structured implementation result containing file edits, files written, and commands needed to verify them. The result must match the CodingImplementerResult schema exactly; invalid submissions will be rejected.',
      parameters: Type.Object({
        fileEdits: Type.Array(
          Type.Object({
            path: Type.String(),
            oldText: Type.String(),
            newText: Type.String(),
            expectedOccurrences: Type.Optional(Type.Number()),
          })
        ),
        writeFiles: Type.Array(
          Type.Object({
            path: Type.String(),
            content: Type.String(),
          })
        ),
        verificationCommands: Type.Array(
          Type.Object({
            name: Type.String(),
            command: Type.String(),
            required: Type.Optional(Type.Boolean()),
            reason: Type.Optional(Type.String()),
            cwd: Type.Optional(Type.String()),
            timeoutSeconds: Type.Optional(Type.Number()),
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
