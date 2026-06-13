import type { AgentProfile, ToolDefinition } from '@flue/runtime';
import { createCodingInternalSubagent } from '../profile-factory.js';

export const codingCodeReviewSubagentName = 'coding-worker-code-review';

export function createCodingCodeReviewSubagent(model?: string, tools?: ToolDefinition[]): AgentProfile {
  return createCodingInternalSubagent({
    kind: 'code-review',
    name: codingCodeReviewSubagentName,
    description: 'Worker-local code review subagent for independent diff, risk, and verification review.',
    workspacePath: 'workers/coding-worker/subagents/code-review/workspace',
    runtimeRole:
      'Review the resulting diff against requirements, verify test evidence, identify risks, and return findings to the lead.',
    model,
    tools,
  });
}
