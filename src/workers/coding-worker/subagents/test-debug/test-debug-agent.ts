import type { AgentProfile, ToolDefinition } from '@flue/runtime';
import { createCodingInternalSubagent } from '../profile-factory.js';

export const codingTestDebugSubagentName = 'coding-worker-test-debug';

export function createCodingTestDebugSubagent(model?: string, tools?: ToolDefinition[]): AgentProfile {
  return createCodingInternalSubagent({
    kind: 'test-debug',
    name: codingTestDebugSubagentName,
    description: 'Worker-local test and debug subagent for verification commands, failures, and reruns.',
    workspacePath: 'workers/coding-worker/subagents/test-debug/workspace',
    runtimeRole:
      'Run focused and full verification through the Flue local sandbox, diagnose failures, and report evidence.',
    model,
    tools,
  });
}
