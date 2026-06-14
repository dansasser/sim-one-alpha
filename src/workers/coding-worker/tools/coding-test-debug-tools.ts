import { defineTool, Type, type ToolDefinition } from '@flue/runtime';
import type { CodingTestDebugResult } from '../../../schemas/coding-worker.js';

export function createCodingTestDebugTools(): ToolDefinition[] {
  return [
    defineTool({
      name: 'coding_test_debug_submit_result',
      description:
        'Submit the final structured CodingTestDebugResult containing debug edits, verification commands, and failure analysis.',
      parameters: Type.Object({
        debugEdits: Type.Array(
          Type.Object({
            path: Type.String(),
            oldText: Type.String(),
            newText: Type.String(),
            expectedOccurrences: Type.Optional(Type.Number()),
          }),
        ),
        verificationCommands: Type.Array(
          Type.Object({
            name: Type.String(),
            command: Type.String(),
            required: Type.Optional(Type.Boolean()),
            reason: Type.Optional(Type.String()),
            cwd: Type.Optional(Type.String()),
            timeoutSeconds: Type.Optional(Type.Number()),
          }),
        ),
        analysis: Type.String(),
      }),
      execute: async (args) => {
        const result: CodingTestDebugResult = {
          debugEdits: args.debugEdits || [],
          verificationCommands: args.verificationCommands || [],
          analysis: args.analysis || '',
        };
        return JSON.stringify({ status: 'submitted', result }, null, 2);
      },
    }),
  ];
}
