import { createCodingApprovalRequest } from '../approvals/approval-policy.js';
import { InMemoryCodingProgressReporter, type CodingProgressReporter } from '../events/progress-reporter.js';
import { createOrchestratorProgressUpdate } from '../events/orchestrator-bridge.js';
import { runCodingRepoPreflight, type CodingRepoPreflight } from '../repo/preflight.js';
import { hasPassingRequiredVerification } from '../repo/verification.js';
import { applyExactTextEdits } from '../tools/coding-repo-tools.js';
import { evaluateCodingShellCommand } from '../tools/command-policy.js';
import {
  createFlueLocalCodingSandbox,
  normalizeRepoRelativePath,
  type CodingSandboxRuntime,
} from '../tools/sandbox-runtime.js';
import {
  resolveCodingWorkspaceTarget,
  type ResolvedCodingWorkspaceTarget,
} from '../repo/workspace-target.js';
import { createCodingWorkerSessionPlan, type CodingWorkerSessionPlan } from '../session/child-session-names.js';
import type {
  CodingFileEdit,
  CodingPlanItem,
  CodingSubagentKind,
  CodingSubagentRunResult,
  CodingVerificationCommand,
  CodingVerificationCommandRequest,
  CodingVerificationEvidence,
  CodingWorkerRunResult,
  CodingWorkerTaskRequest,
} from '../types.js';

export interface CodingTaskWorkflowDependencies {
  preflight?: (scopePath: string, target: ResolvedCodingWorkspaceTarget) => CodingRepoPreflight;
  reporter?: CodingProgressReporter;
  sandbox?: CodingSandboxRuntime;
  createSandbox?: (
    target: ResolvedCodingWorkspaceTarget,
    sessionPlan: CodingWorkerSessionPlan,
  ) => Promise<CodingSandboxRuntime>;
  delegate?: (subagent: CodingSubagentKind, request: CodingTaskSubagentRequest) => Promise<CodingSubagentRunResult>;
  verificationEvidence?: CodingVerificationEvidence[];
}

export interface CodingTaskSubagentRequest {
  task: CodingWorkerTaskRequest;
  sessionPlan: CodingWorkerSessionPlan;
  preflight: CodingRepoPreflight;
  plan: CodingPlanItem[];
}

interface WorkflowVerificationCommand extends CodingVerificationCommand {
  cwd?: string;
  timeoutSeconds?: number;
}

interface WorkflowExecutionState {
  task: CodingWorkerTaskRequest;
  sessionPlan: CodingWorkerSessionPlan;
  preflight: CodingRepoPreflight;
  plan: CodingPlanItem[];
  reporter: CodingProgressReporter;
  sandbox: CodingSandboxRuntime;
  verificationCommands: WorkflowVerificationCommand[];
  verificationEvidence: CodingVerificationEvidence[];
}

export async function runCodingTaskWorkflow(
  task: CodingWorkerTaskRequest,
  dependencies: CodingTaskWorkflowDependencies = {},
): Promise<CodingWorkerRunResult> {
  const reporter = dependencies.reporter ?? new InMemoryCodingProgressReporter();
  const workspaceTarget = resolveCodingWorkspaceTarget(task);
  const repoPath = workspaceTarget.scopePath;
  const sessionPlan = createCodingWorkerSessionPlan(task.taskId, task.sessionId);

  reporter.emit({
    type: 'coding.task.accepted',
    taskId: task.taskId,
    purpose: 'Accept coding task and create stable lead/child session plan.',
    summary: `Accepted coding task ${task.taskId}.`,
    evidence: [
      sessionPlan.leadSessionName,
      `workspaceRoot=${workspaceTarget.workspaceRoot}`,
      `scope=${workspaceTarget.projectRelativePath}`,
    ],
  });

  reporter.emit({
    type: 'coding.action.started',
    taskId: task.taskId,
    action: 'repo-preflight',
    purpose: 'Detect package manager, scripts, and verification commands before model work.',
  });

  const preflightRunner =
    dependencies.preflight ?? ((scopePath: string) => runCodingRepoPreflight(scopePath));
  const preflight = preflightRunner(repoPath, workspaceTarget);
  const verificationCommands = resolveVerificationCommands(task.verificationCommands, preflight);

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

  if (!dependencies.delegate && !hasStructuredExecutionPlan(task)) {
    setPlanStatus(plan, 'triage', 'blocked');
    reporter.emit({
      type: 'coding.blocked',
      taskId: task.taskId,
      risk: 'No live subagent delegate or structured execution plan was supplied.',
      summary: 'Coding worker cannot execute a natural-language coding task in workflow mode without live delegation.',
      nextAction: 'Run through the coding-worker Flue agent profile or supply a structured execution plan.',
    });
    return createBlockedResult(task, plan, [], verificationCommands, dependencies.verificationEvidence ?? [], reporter);
  }

  const sandbox =
    dependencies.sandbox ??
    (await (dependencies.createSandbox ?? createDefaultSandbox)(workspaceTarget, sessionPlan));
  const state: WorkflowExecutionState = {
    task,
    sessionPlan,
    preflight,
    plan,
    reporter,
    sandbox,
    verificationCommands,
    verificationEvidence: [...(dependencies.verificationEvidence ?? [])],
  };

  const subagentResults: CodingSubagentRunResult[] = [];

  for (const subagent of chooseSubagents(task)) {
    reporter.emit({
      type: subagent === 'triage' ? 'coding.triage.started' : 'coding.subagent.started',
      taskId: task.taskId,
      subagent,
      purpose: `Run worker-local ${subagent} subagent in its focused child session.`,
      evidence: [sessionPlan.childSessions[subagent]],
    });

    const result = dependencies.delegate
      ? await dependencies.delegate(subagent, {
          task,
          sessionPlan,
          preflight,
          plan,
        })
      : await runBuiltInSubagentStep(subagent, state);
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

  const commandsWithEvidence = applyVerificationEvidence(verificationCommands, state.verificationEvidence);

  if (!hasPassingRequiredVerification(commandsWithEvidence)) {
    reporter.emit({
      type: 'coding.blocked',
      taskId: task.taskId,
      risk: 'Completing without required verification would violate the coding-worker contract.',
      summary: 'Coding worker cannot report completed without required verification evidence.',
      nextAction: 'Run required verification commands and attach passing evidence.',
    });

    return createBlockedResult(
      task,
      plan,
      subagentResults,
      commandsWithEvidence,
      state.verificationEvidence,
      reporter,
    );
  }

  reporter.emit({
    type: 'coding.completed',
    taskId: task.taskId,
    summary: 'Coding worker completed with required verification evidence.',
    evidence: state.verificationEvidence.map((item) => `${item.command}: ${item.status}`),
  });

  return {
    taskId: task.taskId,
    status: 'completed',
    summary: 'Coding worker completed with required verification evidence.',
    plan,
    subagentResults,
    verification: {
      requiredCommands: commandsWithEvidence,
      evidence: state.verificationEvidence,
    },
    publicEvents: createOrchestratorProgressUpdate(task.taskId, reporter.events()).events,
    artifacts: [],
  };
}

export function createInitialCodingPlan(task: CodingWorkerTaskRequest): CodingPlanItem[] {
  const plan: CodingPlanItem[] = [
    {
      id: `${task.taskId}:triage`,
      description: 'Triage request, workspace/project scope, repository state, GitHub context, and required internal subagents.',
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

  if (task.github?.issueNumber || task.github?.pullRequestNumber || task.github?.url) {
    plan.push({
      id: `${task.taskId}:github`,
      description: 'Gather GitHub context and prepare approval-gated remote actions.',
      owner: 'github',
      status: 'pending',
    });
  }

  return plan;
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

async function runBuiltInSubagentStep(
  subagent: CodingSubagentKind,
  state: WorkflowExecutionState,
): Promise<CodingSubagentRunResult> {
  switch (subagent) {
    case 'triage':
      return runBuiltInTriage(state);
    case 'implementer':
      return runBuiltInImplementation(state);
    case 'test-debug':
      return runBuiltInTestDebug(state);
    case 'code-review':
      return runBuiltInCodeReview(state);
    case 'github':
      return {
        subagent,
        summary: 'GitHub context is available to the coding-worker lead through worker-owned GitHub tools.',
        evidence: ['coding_github_read_context', 'approval-gated GitHub write actions'],
      };
  }
}

async function runBuiltInTriage(state: WorkflowExecutionState): Promise<CodingSubagentRunResult> {
  setPlanStatus(state.plan, 'triage', 'in_progress');
  const files = state.task.filesToInspect ?? [];
  const evidence: string[] = [];

  for (const file of files) {
    if (await state.sandbox.exists(file)) {
      evidence.push(normalizeRepoRelativePath(state.sandbox.repoPath, file));
    }
  }

  const gitStatus = await state.sandbox.exec('git status --short', { timeoutSeconds: 30 });
  if (gitStatus.exitCode === 0 && gitStatus.stdout.trim()) {
    evidence.push(gitStatus.stdout.trim());
  }

  setPlanStatus(state.plan, 'triage', 'completed');
  return {
    subagent: 'triage',
    summary: 'Triage inspected the requested workspace/project context and selected the coding-worker execution path.',
    evidence,
    nextAction: 'Apply scoped edits and run verification.',
  };
}

async function runBuiltInImplementation(state: WorkflowExecutionState): Promise<CodingSubagentRunResult> {
  setPlanStatus(state.plan, 'implementer', 'in_progress');
  const evidence: string[] = [];

  for (const write of state.task.writeFiles ?? []) {
    await state.sandbox.writeFile(write.path, write.content);
    evidence.push(`wrote ${normalizeRepoRelativePath(state.sandbox.repoPath, write.path)}`);
  }

  for (const edit of state.task.fileEdits ?? []) {
    const replacements = await applyEdit(state.sandbox, edit);
    evidence.push(`patched ${normalizeRepoRelativePath(state.sandbox.repoPath, edit.path)} (${replacements})`);
  }

  setPlanStatus(state.plan, 'implementer', 'completed');
  return {
    subagent: 'implementer',
    summary: evidence.length
      ? 'Implementation applied structured workspace/project edits.'
      : 'No implementation edits were required.',
    evidence,
    nextAction: 'Run focused and required verification.',
  };
}

async function runBuiltInTestDebug(state: WorkflowExecutionState): Promise<CodingSubagentRunResult> {
  setPlanStatus(state.plan, 'test-debug', 'in_progress');
  const firstRun = await runVerification(state);
  const failedRequired = firstRun.some((item) => item.required && item.evidence.status === 'failed');
  const evidence = firstRun.map((item) => `${item.command.command}: ${item.evidence.status}`);

  if (failedRequired && state.task.debugEdits?.length) {
    state.reporter.emit({
      type: 'coding.action.started',
      taskId: state.task.taskId,
      action: 'debug-loop',
      summary: 'Verification failed; applying debug edits before rerunning checks.',
    });
    for (const edit of state.task.debugEdits) {
      const replacements = await applyEdit(state.sandbox, edit);
      evidence.push(`debug patched ${normalizeRepoRelativePath(state.sandbox.repoPath, edit.path)} (${replacements})`);
    }
    const secondRun = await runVerification(state);
    evidence.push(...secondRun.map((item) => `${item.command.command}: ${item.evidence.status}`));
  }

  setPlanStatus(state.plan, 'test-debug', 'completed');
  return {
    subagent: 'test-debug',
    summary: 'Verification commands were executed through the coding-worker local sandbox.',
    evidence,
    nextAction: 'Review the resulting diff and verification evidence.',
  };
}

async function runBuiltInCodeReview(state: WorkflowExecutionState): Promise<CodingSubagentRunResult> {
  setPlanStatus(state.plan, 'code-review', 'in_progress');
  const evidence: string[] = [];
  const diffStat = await state.sandbox.exec('git diff --stat', { timeoutSeconds: 30 });
  if (diffStat.exitCode === 0 && diffStat.stdout.trim()) {
    evidence.push(diffStat.stdout.trim());
  }

  const diffCheck = await state.sandbox.exec('git diff --check', { timeoutSeconds: 30 });
  evidence.push(`git diff --check: ${diffCheck.exitCode === 0 ? 'passed' : 'failed'}`);

  setPlanStatus(state.plan, 'code-review', 'completed');
  return {
    subagent: 'code-review',
    summary: 'Code review inspected the diff and whitespace check results.',
    evidence,
    nextAction: 'Return structured completion status to the orchestrator.',
  };
}

async function runVerification(
  state: WorkflowExecutionState,
): Promise<Array<{ command: WorkflowVerificationCommand; evidence: CodingVerificationEvidence; required: boolean }>> {
  const results: Array<{ command: WorkflowVerificationCommand; evidence: CodingVerificationEvidence; required: boolean }> = [];

  for (const command of state.verificationCommands) {
    state.reporter.emit({
      type: 'coding.verification.started',
      taskId: state.task.taskId,
      command: command.command,
      summary: `Running verification: ${command.command}`,
    });

    const policy = evaluateCodingShellCommand(command.command);
    if (!policy.allowed) {
      const evidence = {
        command: command.command,
        status: 'failed' as const,
        exitCode: 1,
        summary: policy.reason ?? 'Command blocked by coding-worker command policy.',
      };
      state.verificationEvidence.push(evidence);
      results.push({ command, evidence, required: command.required });
      state.reporter.emit({
        type: 'coding.verification.completed',
        taskId: state.task.taskId,
        command: command.command,
        status: evidence.status,
        summary: evidence.summary,
      });
      continue;
    }

    const shellResult = await state.sandbox.exec(command.command, {
      cwd: command.cwd,
      timeoutSeconds: command.timeoutSeconds ?? 120,
    });
    const evidence = {
      command: command.command,
      status: shellResult.exitCode === 0 ? ('passed' as const) : ('failed' as const),
      exitCode: shellResult.exitCode,
      summary: summarizeShellResult(shellResult.stdout, shellResult.stderr),
    };
    state.verificationEvidence.push(evidence);
    results.push({ command, evidence, required: command.required });

    state.reporter.emit({
      type: 'coding.verification.completed',
      taskId: state.task.taskId,
      command: command.command,
      status: evidence.status,
      summary: evidence.summary,
    });
  }

  return results;
}

async function applyEdit(sandbox: CodingSandboxRuntime, edit: CodingFileEdit): Promise<number> {
  const original = await sandbox.readFile(edit.path);
  const { content, replacements } = applyExactTextEdits(original, [edit]);
  await sandbox.writeFile(edit.path, content);
  return replacements;
}

function applyVerificationEvidence(
  commands: WorkflowVerificationCommand[],
  evidence: CodingVerificationEvidence[],
): CodingVerificationCommand[] {
  return commands.map((command) => {
    const latestEvidence = evidence.filter((item) => item.command === command.command).at(-1);
    return latestEvidence ? { ...command, status: latestEvidence.status } : command;
  });
}

function resolveVerificationCommands(
  requestedCommands: CodingVerificationCommandRequest[] | undefined,
  preflight: CodingRepoPreflight,
): WorkflowVerificationCommand[] {
  if (!requestedCommands?.length) {
    return preflight.verificationPlan;
  }

  return requestedCommands.map((command) => ({
    name: command.name,
    command: command.command,
    required: command.required ?? true,
    reason: command.reason ?? 'Task-specific verification command.',
    cwd: command.cwd,
    timeoutSeconds: command.timeoutSeconds,
    status: 'pending',
  }));
}

function hasStructuredExecutionPlan(task: CodingWorkerTaskRequest): boolean {
  return Boolean(
    task.fileEdits?.length ||
      task.writeFiles?.length ||
      task.debugEdits?.length ||
      task.verificationCommands?.length ||
      task.filesToInspect?.length,
  );
}

function createBlockedResult(
  task: CodingWorkerTaskRequest,
  plan: CodingPlanItem[],
  subagentResults: CodingSubagentRunResult[],
  requiredCommands: CodingVerificationCommand[],
  evidence: CodingVerificationEvidence[],
  reporter: CodingProgressReporter,
): CodingWorkerRunResult {
  return {
    taskId: task.taskId,
    status: 'blocked',
    summary: 'Required coding-worker execution or verification evidence is missing or failing.',
    plan,
    subagentResults,
    verification: {
      requiredCommands,
      evidence,
    },
    publicEvents: createOrchestratorProgressUpdate(task.taskId, reporter.events()).events,
    artifacts: [],
  };
}

function setPlanStatus(
  plan: CodingPlanItem[],
  owner: CodingPlanItem['owner'],
  status: CodingPlanItem['status'],
): void {
  const item = plan.find((entry) => entry.owner === owner);
  if (item) {
    item.status = status;
  }
}

function summarizeShellResult(stdout: string, stderr: string): string {
  const combined = `${stdout}\n${stderr}`.trim();
  return combined ? combined.slice(0, 1_000) : 'Command produced no output.';
}

async function createDefaultSandbox(
  target: ResolvedCodingWorkspaceTarget,
  sessionPlan: CodingWorkerSessionPlan,
): Promise<CodingSandboxRuntime> {
  return createFlueLocalCodingSandbox({
    workspaceRoot: target.workspaceRoot,
    targetKind: target.targetKind,
    projectId: target.projectId,
    projectSlug: target.projectSlug,
    projectRelativePath: target.projectRelativePath,
    sessionId: sessionPlan.leadSessionName,
  });
}
