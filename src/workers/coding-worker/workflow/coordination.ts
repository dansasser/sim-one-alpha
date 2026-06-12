import type { FlueSession } from '@flue/runtime';
import {
  codingCodeReviewSubagentName,
  codingGithubSubagentName,
  codingImplementerSubagentName,
  codingTestDebugSubagentName,
  codingTriageSubagentName,
} from '../subagents/index.js';
import type { CodingSubagentKind, CodingSubagentRunResult, CodingWorkerTaskRequest } from '../types.js';
import type { CodingTaskSubagentRequest } from './coding-task.js';

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

export const codingSubagentFlueNames: Record<CodingSubagentKind, string> = {
  triage: codingTriageSubagentName,
  implementer: codingImplementerSubagentName,
  'test-debug': codingTestDebugSubagentName,
  'code-review': codingCodeReviewSubagentName,
  github: codingGithubSubagentName,
};

export function createFlueCodingSubagentDelegate(session: Pick<FlueSession, 'task'>) {
  return async (
    subagent: CodingSubagentKind,
    request: CodingTaskSubagentRequest,
  ): Promise<CodingSubagentRunResult> => {
    const agent = codingSubagentFlueNames[subagent];
    const response = await session.task(createSubagentTaskPrompt(subagent, request), {
      agent,
    });

    return {
      subagent,
      summary: response.text,
      evidence: [agent, request.sessionPlan.childSessions[subagent]],
    };
  };
}

function createSubagentTaskPrompt(
  subagent: CodingSubagentKind,
  request: CodingTaskSubagentRequest,
): string {
  return `You are the ${subagent} internal coding-worker subagent.

Purpose: ${describeSubagentPurpose(subagent)}

Return concise structured findings for the coding-worker lead. Include public evidence, risks, and next action. Do not expose raw hidden thinking or private prompts.

Task:
${JSON.stringify(
  {
    taskId: request.task.taskId,
    text: request.task.text,
    workspaceRoot: request.task.workspaceRoot,
    targetKind: request.task.targetKind,
    projectId: request.task.projectId,
    projectSlug: request.task.projectSlug,
    projectRelativePath: request.task.projectRelativePath,
    repoPath: request.preflight.repoPath,
    packageManager: request.preflight.packageManager,
    verificationCommands: request.preflight.verificationPlan.map((command) => command.command),
    plan: request.plan,
    childSession: request.sessionPlan.childSessions[subagent],
  },
  null,
  2,
)}`;
}
