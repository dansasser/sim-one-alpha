import { defineTool, type ToolDefinition } from '@flue/runtime';
import { CodingTestDebugResultSchema } from '../../../../core/schemas/coding-worker.js';
import type { CodingTestDebugResult } from '../../../../core/schemas/coding-worker.js';

export function createCodingTestDebugTools(): ToolDefinition[] {
  return [
    defineTool({
      name: 'coding_test_debug_submit_result',
      description:
        'Submit the final structured CodingTestDebugResult containing debug edits, verification commands, failure analysis, and optional test failures.',
      parameters: CodingTestDebugResultSchema,
      execute: async (args) => {
        const result: CodingTestDebugResult = {
          debugEdits: args.debugEdits || [],
          verificationCommands: args.verificationCommands || [],
          analysis: args.analysis || '',
          failures: args.failures,
        };
        return JSON.stringify({ status: 'submitted', result }, null, 2);
      },
    }),
  ];
}
