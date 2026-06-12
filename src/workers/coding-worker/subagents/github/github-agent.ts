import type { AgentProfile } from '@flue/runtime';
import { createCodingInternalSubagent } from '../profile-factory.js';

export const codingGithubSubagentName = 'coding-worker-github';

export function createCodingGithubSubagent(model?: string): AgentProfile {
  return createCodingInternalSubagent({
    kind: 'github',
    name: codingGithubSubagentName,
    description: 'Worker-local GitHub subagent for issue, PR, checks, comments, and approval-gated publishing.',
    workspacePath: 'workers/coding-worker/subagents/github/workspace',
    runtimeRole:
      'Gather GitHub context and prepare approval-gated GitHub side effects without performing unapproved writes.',
    model,
  });
}
