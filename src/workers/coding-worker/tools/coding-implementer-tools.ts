import { defineTool, Type, type ToolDefinition } from '@flue/runtime';
import type { CodingImplementerResult } from '../types.js';

export function createCodingImplementerTools(): ToolDefinition[] {
  return [
    defineTool({
      name: 'coding_implementer_submit_result',
      description: 'Submit the final structured implementation result containing file edits, files written, and commands needed to verify them.',
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
        // Validation could be added here
        const result: CodingImplementerResult = {
          fileEdits: args.fileEdits || [],
          writeFiles: args.writeFiles || [],
          verificationCommands: args.verificationCommands || [],
        };
        return JSON.stringify({ status: 'submitted', result }, null, 2);
      },
    }),
  ];
}
