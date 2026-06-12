import { createCodingApprovalRequest } from '../approvals/approval-policy.js';
import { InMemoryCodingProgressReporter, type CodingProgressReporter } from '../events/progress-reporter.js';
import { createOrchestratorProgressUpdate } from '../events/orchestrator-bridge.js';
import { runCodingRepoPreflight, type CodingRepoPreflight } from '../repo/preflight.js';
import { hasPassingRequiredVerification } from '../repo/verification.js';
import { createCodingWorkerSessionPlan, type CodingWorkerSessionPlan } from '../session/child-session-names.js';
import type {
  CodingPlanItem,
  CodingSubagentKind,
  CodingSubagentRunResult,
  CodingVerificationEvidence,
  CodingWorkerRunResult,
  CodingWorkerTaskRequest,
} from '../types.js';

export interface CodingTaskWorkflowDependencies {
  preflight?: (repoPath: string) => CodingRepoPreflight;
  reporter?: CodingProgressReporter;
  delegate?: (subagent: CodingSubagentKind, request: CodingTaskSubagentRequest) => Promise<CodingSubagentRunResult>;
  verificationEvidence?: CodingVerificationEvidence[];
}

export interface CodingTaskSubagentRequest {
  task: CodingWorkerTaskRequest;
  sessionPlan: CodingWorkerSessionPlan;
  preflight: CodingRepoPreflight;
  plan: CodingPlanItem[];
}

export async function runCodingTaskWorkflow(
  task: CodingWorkerTaskRequest,
  dependencies: CodingTaskWorkflowDependencies = {},
): Promise<CodingWorkerRunResult> {
  const reporter = dependencies.reporter ?? new InMemoryCodingProgressReporter();
  const repoPath = task.repoPath ?? process.cwd();
  const sessionPlan = createCodingWorkerSessionPlan(task.taskId, task.sessionId);

  reporter.emit({
    type: 'coding.task.accepted',
    taskId: task.taskId,
    purpose: 'Accept coding task and create stable lead/child session plan.',
    summary: `Accepted coding task ${task.taskId}.`,
    evidence: [sessionPlan.leadSessionName],
  });

  reporter.emit({
    type: 'coding.action.started',
    taskId: task.taskId,
    action: 'repo-preflight',
    purpose: 'Detect package manager, scripts, and verification commands before model work.',
  });

  const preflight = (dependencies.preflight ?? runCodingRepoPreflight)(repoPath);
  const verificationCommands = preflight.verificationPlan;

  reporter.emit({
    type: 'coding.action.completed',
    taskId: task.taskId,
    action: 'repo-preflight',
    summary: `Detected ${preflight.packageManager} with ${Object.keys(preflight.scripts).length} package scripts.`,
    evidence: verificationCommands.map((command) => command.command),
  });

  const plan = createInitialCodingPlan(task);
  reporter.emit({
    type: 'coding.plan.updated',
    taskId: task.taskId,
    purpose: 'Make the worker-local subagent plan visible before execution.',
    plan,
    summary: 'Initial coding-worker plan created.',
  });

  const subagentResults: CodingSubagentRunResult[] = [];
  const delegate = dependencies.delegate ?? createPlanningOnlyDelegate();

  for (const subagent of chooseSubagents(task)) {
    reporter.emit({
      type: subagent === 'triage' ? 'coding.triage.started' : 'coding.subagent.started',
      taskId: task.taskId,
      subagent,
      purpose: `Run worker-local ${subagent} subagent in its focused child session.`,
      evidence: [sessionPlan.childSessions[subagent]],
    });

    const result = await delegate(subagent, {
      task,
      sessionPlan,
      preflight,
      plan,
    });
    subagentResults.push(result);

    reporter.emit({
      type: subagent === 'triage' ? 'coding.triage.completed' : 'coding.subagent.completed',
      taskId: task.taskId,
      subagent,
      summary: result.summary,
      evidence: result.evidence,
      nextAction: result.nextAction,
    });
  }

  const verificationEvidence = dependencies.verificationEvidence ?? [];
  const commandsWithEvidence = verificationCommands.map((command) => {
    const evidence = verificationEvidence.find((item) => item.command === command.command);
    return evidence ? { ...command, status: evidence.status } : command;
  });

  if (!hasPassingRequiredVerification(commandsWithEvidence)) {
    reporter.emit({
      type: 'coding.blocked',
      taskId: task.taskId,
      risk: 'Completing without required verification would violate the coding-worker contract.',
      summary: 'Coding worker cannot report completed without required verification evidence.',
      nextAction: 'Run required verification commands and attach passing evidence.',
    });

    return {
      taskId: task.taskId,
      status: 'blocked',
      summary: 'Required verification evidence is missing or failing.',
      plan,
      subagentResults,
      verification: {
        requiredCommands: commandsWithEvidence,
        evidence: verificationEvidence,
      },
      publicEvents: createOrchestratorProgressUpdate(task.taskId, reporter.events()).events,
      artifacts: [],
    };
  }

  reporter.emit({
    type: 'coding.completed',
    taskId: task.taskId,
    summary: 'Coding worker completed with required verification evidence.',
    evidence: verificationEvidence.map((item) => `${item.command}: ${item.status}`),
  });

  return {
    taskId: task.taskId,
    status: 'completed',
    summary: 'Coding worker completed with required verification evidence.',
    plan,
    subagentResults,
    verification: {
      requiredCommands: commandsWithEvidence,
      evidence: verificationEvidence,
    },
    publicEvents: createOrchestratorProgressUpdate(task.taskId, reporter.events()).events,
    artifacts: [],
  };
}

export function createInitialCodingPlan(task: CodingWorkerTaskRequest): CodingPlanItem[] {
  return [
    {
      id: `${task.taskId}:triage`,
      description: 'Triage request, scope, repository state, GitHub context, and required internal subagents.',
      owner: 'triage',
      status: 'pending',
    },
    {
      id: `${task.taskId}:implementation`,
      description: 'Implement scoped changes through the coding-worker local sandbox when required.',
      owner: 'implementer',
      status: 'pending',
    },
    {
      id: `${task.taskId}:verification`,
      description: 'Run focused and required verification before completion.',
      owner: 'test-debug',
      status: 'pending',
    },
    {
      id: `${task.taskId}:review`,
      description: 'Review the resulting diff, risks, and verification evidence independently.',
      owner: 'code-review',
      status: 'pending',
    },
  ];
}

export function chooseSubagents(task: CodingWorkerTaskRequest): CodingSubagentKind[] {
  const subagents: CodingSubagentKind[] = ['triage', 'implementer', 'test-debug', 'code-review'];
  if (task.github?.issueNumber || task.github?.pullRequestNumber || task.github?.url) {
    subagents.push('github');
  }
  return subagents;
}

export function createGithubApprovalEvent(taskId: string, action: string) {
  const request = createCodingApprovalRequest({
    taskId,
    actionType: 'github.pr.create',
    summary: action,
    reason: 'GitHub write actions must be approved before execution.',
    risk: 'This can publish or mutate remote GitHub state.',
  });

  return {
    type: 'coding.github.approval_requested' as const,
    taskId,
    action,
    approvalReason: request.reason,
    risk: request.risk,
  };
}

function createPlanningOnlyDelegate() {
  return async (subagent: CodingSubagentKind): Promise<CodingSubagentRunResult> => ({
    subagent,
    summary: `${subagent} subagent planned but no live model delegation was injected for this workflow run.`,
    evidence: ['planning-only delegate'],
    nextAction: 'Inject a live Flue session delegate when executing model-backed coding work.',
  });
}

