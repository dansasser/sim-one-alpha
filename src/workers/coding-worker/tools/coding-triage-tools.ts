import { defineTool, Type, type ToolDefinition } from '@flue/runtime';
import type { CodingTriageResult } from '../../../schemas/coding-worker.js';

export function createCodingTriageTools(): ToolDefinition[] {
  return [
    defineTool({
      name: 'coding_triage_submit_result',
      description:
        'Submit the final structured triage result containing an explicit plan, files to inspect, and the recommended execution path.',
      parameters: Type.Object({
        plan: Type.Array(
          Type.Object({
            id: Type.String(),
            description: Type.String(),
            owner: Type.Union([
              Type.Literal('triage'),
              Type.Literal('implementer'),
              Type.Literal('test-debug'),
              Type.Literal('code-review'),
              Type.Literal('github'),
              Type.Literal('coding-worker'),
            ]),
            status: Type.Union([
              Type.Literal('pending'),
              Type.Literal('in_progress'),
              Type.Literal('completed'),
              Type.Literal('blocked'),
            ]),
          })
        ),
        filesToInspect: Type.Array(Type.String()),
        recommendedExecutionPath: Type.Union([
          Type.Literal('implementer'),
          Type.Literal('github'),
          Type.Literal('test-debug'),
          Type.Literal('code-review'),
          Type.Literal('manual'),
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
