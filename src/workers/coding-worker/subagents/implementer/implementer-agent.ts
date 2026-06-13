import type { AgentProfile, ToolDefinition } from '@flue/runtime';
import { createCodingInternalSubagent } from '../profile-factory.js';

export const codingImplementerSubagentName = 'coding-worker-implementer';

export function createCodingImplementerSubagent(model?: string, tools?: ToolDefinition[]): AgentProfile {
  return createCodingInternalSubagent({
    kind: 'implementer',
    name: codingImplementerSubagentName,
    description: 'Worker-local implementer subagent for scoped code edits inside the coding-worker subsystem.',
    workspacePath: 'workers/coding-worker/subagents/implementer/workspace',
    runtimeRole:
      'Apply approved scoped code changes using the Flue local sandbox supplied by the coding task workflow.',
    model,
    tools,
  });
}
