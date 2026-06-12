import type { AgentProfile } from '@flue/runtime';
import { createCodingInternalSubagent } from '../profile-factory.js';

export const codingTriageSubagentName = 'coding-worker-triage';

export function createCodingTriageSubagent(model?: string): AgentProfile {
  return createCodingInternalSubagent({
    kind: 'triage',
    name: codingTriageSubagentName,
    description: 'Worker-local coding triage subagent for task classification, scope, and delegation planning.',
    workspacePath: 'workers/coding-worker/subagents/triage/workspace',
    runtimeRole:
      'Classify the coding request, identify required context, choose needed internal coding subagents, and produce a public triage summary.',
    model,
  });
}
