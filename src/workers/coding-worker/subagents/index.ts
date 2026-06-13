import type { AgentProfile } from '@flue/runtime';
import { createCodingCodeReviewSubagent, codingCodeReviewSubagentName } from './code-review/code-review-agent.js';
import { createCodingGithubSubagent, codingGithubSubagentName } from './github/github-agent.js';
import { createCodingImplementerSubagent, codingImplementerSubagentName } from './implementer/implementer-agent.js';
import { createCodingTestDebugSubagent, codingTestDebugSubagentName } from './test-debug/test-debug-agent.js';
import { createCodingTriageSubagent, codingTriageSubagentName } from './triage/triage-agent.js';

export const codingWorkerInternalSubagentNames = [
  codingTriageSubagentName,
  codingImplementerSubagentName,
  codingTestDebugSubagentName,
  codingCodeReviewSubagentName,
  codingGithubSubagentName,
] as const;

export function createCodingWorkerInternalSubagents(model?: string): AgentProfile[] {
  return [
    createCodingTriageSubagent(model),
    createCodingImplementerSubagent(model),
    createCodingTestDebugSubagent(model),
    createCodingCodeReviewSubagent(model),
    createCodingGithubSubagent(model),
  ];
}

export {
  codingCodeReviewSubagentName,
  codingGithubSubagentName,
  codingImplementerSubagentName,
  codingTestDebugSubagentName,
  codingTriageSubagentName,
  createCodingCodeReviewSubagent,
  createCodingGithubSubagent,
  createCodingImplementerSubagent,
  createCodingTestDebugSubagent,
  createCodingTriageSubagent,
};

