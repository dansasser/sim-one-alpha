import type { AgentProfile, ToolDefinition } from '@flue/runtime';
import { createCodingInternalSubagent } from '../profile-factory.js';

export const codingTriageSubagentName = 'coding-worker-triage';

export function createCodingTriageSubagent(model?: string, tools?: ToolDefinition[]): AgentProfile {
  return createCodingInternalSubagent({
    kind: 'triage',
    name: codingTriageSubagentName,
    description: 'Worker-local coding triage subagent that returns a CodingTriageResult with an explicit plan.',
    workspacePath: 'workers/coding-worker/subagents/triage/workspace',
    runtimeRole:
      'Classify the coding request, identify required context, choose needed internal coding subagents, and emit a CodingTriageResult containing an explicit plan, files to inspect, and the recommended execution path. Use the coding_triage_submit_result tool to return the structured result.',
    model,
    tools,
  });
}
