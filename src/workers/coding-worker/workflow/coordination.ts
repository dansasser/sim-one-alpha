import type { CodingSubagentKind, CodingWorkerTaskRequest } from '../types.js';

export function shouldUseGithubSubagent(task: CodingWorkerTaskRequest): boolean {
  return Boolean(task.github?.issueNumber || task.github?.pullRequestNumber || task.github?.url);
}

export function describeSubagentPurpose(subagent: CodingSubagentKind): string {
  switch (subagent) {
    case 'triage':
      return 'Classify task and choose coding-worker internal execution path.';
    case 'implementer':
      return 'Apply scoped code edits in the local sandbox.';
    case 'test-debug':
      return 'Run verification and diagnose failures.';
    case 'code-review':
      return 'Review diff, risks, and verification evidence.';
    case 'github':
      return 'Gather GitHub context and prepare approval-gated remote actions.';
  }
}

