import { defineTool, type ToolDefinition } from '@flue/runtime';
import * as v from 'valibot';
import type { CodingTriageResult } from '../../../../core/schemas/coding-worker.js';

export function createCodingTriageTools(): ToolDefinition[] {
  return [
    defineTool({
      name: 'coding_triage_submit_result',
      description:
        'Submit the final structured triage result containing an explicit plan, files to inspect, and the recommended execution path.',
      parameters: v.object({
        plan: v.array(
          v.object({
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
            status: v.union([
              v.literal('pending'),
              v.literal('in_progress'),
              v.literal('completed'),
              v.literal('blocked'),
            ]),
          })
        ),
        filesToInspect: v.array(v.string()),
        recommendedExecutionPath: v.union([
          v.literal('implementer'),
          v.literal('github'),
          v.literal('test-debug'),
          v.literal('code-review'),
          v.literal('manual'),
        ]),
      }),
      execute: async (args) => {
        const result: CodingTriageResult = {
          plan: args.plan || [],
          filesToInspect: args.filesToInspect || [],
          recommendedExecutionPath: args.recommendedExecutionPath ?? 'implementer',
        };
        return JSON.stringify({ status: 'submitted', result }, null, 2);
      },
    }),
  ];
}
