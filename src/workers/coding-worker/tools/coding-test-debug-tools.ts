import { defineTool, type ToolDefinition } from '@flue/runtime';
import * as v from 'valibot';
import type { CodingTestDebugResult } from '../../../schemas/coding-worker.js';

export function createCodingTestDebugTools(): ToolDefinition[] {
  return [
    defineTool({
      name: 'coding_test_debug_submit_result',
      description:
        'Submit the final structured CodingTestDebugResult containing debug edits, verification commands, and failure analysis.',
      parameters: v.object({
        debugEdits: v.array(
          v.object({
            path: v.string(),
            oldText: v.string(),
            newText: v.string(),
            expectedOccurrences: v.optional(v.number()),
          }),
        ),
        verificationCommands: v.array(
          v.object({
            name: v.string(),
            command: v.string(),
            required: v.optional(v.boolean()),
            reason: v.optional(v.string()),
            cwd: v.optional(v.string()),
            timeoutSeconds: v.optional(v.number()),
          }),
        ),
        analysis: v.string(),
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
