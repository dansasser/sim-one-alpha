import type { FlueSession } from '@flue/runtime';
import {
  codingCodeReviewSubagentName,
  codingGithubSubagentName,
  codingImplementerSubagentName,
  codingTestDebugSubagentName,
  codingTriageSubagentName,
} from '../subagents/index.js';
import {
  CodingImplementerResultSchema,
  CodingTriageResultSchema,
  CodingTestDebugResultSchema,
  CodingCodeReviewResultSchema,
  CodingGithubResultSchema,
} from '../../../schemas/coding-worker.js';
import type {
  CodingSubagentKind,
  CodingSubagentRunResult,
  CodingWorkerTaskRequest,
} from '../types.js';
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
    const prompt = createSubagentTaskPrompt(subagent, request);
    const evidence = [agent, request.sessionPlan.childSessions[subagent]];

    switch (subagent) {
      case 'triage': {
        const response = await session.task(prompt, {
          agent,
          result: CodingTriageResultSchema,
        });
        const result = response.data;
        const summary = `Triage selected execution path: ${result.recommendedExecutionPath} with explicit plan (${result.plan.length} item(s)).`;
        return {
          subagent,
          summary,
          evidence,
          structuredOutput: { type: 'triage', result },
        };
      }
      case 'implementer': {
        const response = await session.task(prompt, {
          agent,
          result: CodingImplementerResultSchema,
        });
        const result = response.data;
        const summary = `Implementer submitted ${result.fileEdits.length} edit(s), ${result.writeFiles.length} file write(s), and ${result.verificationCommands.length} verification command(s).`;
        return {
          subagent,
          summary,
          evidence,
          structuredOutput: { type: 'implementer', result },
        };
      }
      case 'test-debug': {
        const response = await session.task(prompt, {
          agent,
          result: CodingTestDebugResultSchema,
        });
        const result = response.data;
        const summary = `Test-debug produced ${result.debugEdits.length} debug edit(s) and ${result.verificationCommands.length} verification command(s).`;
        return {
          subagent,
          summary,
          evidence,
          structuredOutput: { type: 'test-debug', result },
        };
      }
      case 'code-review': {
        const response = await session.task(prompt, {
          agent,
          result: CodingCodeReviewResultSchema,
        });
        const result = response.data;
        const summary = `Code review returned ${result.findings.length} finding(s); approved=${result.approved}.`;
        return {
          subagent,
          summary,
          evidence,
          structuredOutput: { type: 'code-review', result },
        };
      }
      case 'github': {
        const response = await session.task(prompt, {
          agent,
          result: CodingGithubResultSchema,
        });
        const result = response.data;
        const summary = `GitHub subagent prepared ${result.actions.length} action(s).`;
        return {
          subagent,
          summary,
          evidence,
          structuredOutput: { type: 'github', result },
        };
      }
    }
  };
}

function createSubagentTaskPrompt(
  subagent: CodingSubagentKind,
  request: CodingTaskSubagentRequest,
): string {
  const verificationCommands = request.task.verificationCommands?.length
    ? request.task.verificationCommands.map((command) => command.command)
    : request.preflight.verificationPlan.map((command) => command.command);

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
    verificationCommands,
    plan: request.plan,
    childSession: request.sessionPlan.childSessions[subagent],
  },
  null,
  2,
)}`;
}
