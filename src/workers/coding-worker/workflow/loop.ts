import { createCodingApprovalRequest } from '../approvals/approval-policy.js';
import type { CodingApprovalService } from '../approvals/approval-service.js';
import { InMemoryCodingProgressReporter, type CodingProgressReporter } from '../events/progress-reporter.js';
import { createOrchestratorProgressUpdate } from '../events/orchestrator-bridge.js';
import type { GitHubClient } from '../github/github-client.js';
import { runCodingRepoPreflight, type CodingRepoPreflight } from '../repo/preflight.js';
import { parseVerificationCommandFailures } from '../repo/verification.js';
import { resolveCodingWorkspaceTarget, type ResolvedCodingWorkspaceTarget } from '../repo/workspace-target.js';
import { createCodingWorkerSessionPlan, type CodingWorkerSessionPlan } from '../session/child-session-names.js';
import {
  JsonFileCodingTaskRunStore,
  type CodingTaskRunStore,
} from '../session/task-run-store.js';
import {
  applyCodingEditTransaction,
  createCodingEditTransaction,
  type CodingEditTransaction,
} from '../tools/coding-repo-tools.js';
import { evaluateCodingShellCommand } from '../tools/command-policy.js';
import {
  createFlueLocalCodingSandbox,
  type CodingSandboxRuntime,
} from '../tools/sandbox-runtime.js';
import type {
  CodingFileEdit,
  CodingFileWrite,
  CodingPlanItem,
  CodingSubagentKind,
  CodingSubagentRunResult,
  CodingVerificationCommand,
  CodingVerificationCommandRequest,
  CodingVerificationEvidence,
  CodingWorkerLoopCheckpoint,
  CodingWorkerLoopState,
  CodingWorkerLoopStep,
  CodingWorkerRunResult,
  CodingWorkerRunStatus,
  CodingWorkerTaskRequest,
} from '../types.js';
import type { FlueSession } from '@flue/runtime';
import { createInitialCodingPlan, chooseSubagents, setPlanStatus } from './coding-task.js';
import { createInitialPlan, replan } from './planning.js';
import type { CodingTaskSubagentRequest } from './coding-task.js';
import { createFlueCodingSubagentDelegate } from './coordination.js';

export interface CodingWorkerLoopDependencies {
  reporter?: CodingProgressReporter;
  sandbox?: CodingSandboxRuntime;
  taskRunStore?: CodingTaskRunStore;
  approvalService?: CodingApprovalService;
  githubClient?: GitHubClient;
  preflight?: (scopePath: string, target: ResolvedCodingWorkspaceTarget) => CodingRepoPreflight;
  delegate?: (subagent: CodingSubagentKind, request: CodingTaskSubagentRequest) => Promise<CodingSubagentRunResult>;
  maxTurns?: number;
  maxReplans?: number;
  createSandbox?: (
    target: ResolvedCodingWorkspaceTarget,
    sessionPlan: CodingWorkerSessionPlan,
  ) => Promise<CodingSandboxRuntime>;
}

interface LoopVerificationCommand extends CodingVerificationCommand {
  cwd?: string;
  timeoutSeconds?: number;
}

const DEFAULT_MAX_TURNS = 10;
const DEFAULT_MAX_REPLANS = 3;

export async function runCodingWorkerLoop(
  task: CodingWorkerTaskRequest,
  dependencies: CodingWorkerLoopDependencies = {},
): Promise<CodingWorkerRunResult> {
  const reporter = dependencies.reporter ?? new InMemoryCodingProgressReporter();
  dependencies.reporter = reporter;
  const workspaceTarget = resolveCodingWorkspaceTarget(task);
  const sessionPlan = createCodingWorkerSessionPlan(task.taskId, task.sessionId);
  const taskRunStore = dependencies.taskRunStore ?? JsonFileCodingTaskRunStore.atWorkspaceRoot(workspaceTarget.workspaceRoot);
  const createdAt = new Date().toISOString();
  const maxTurns = dependencies.maxTurns ?? task.maxTurns ?? DEFAULT_MAX_TURNS;

  reporter.emit({
    type: 'coding.task.accepted',
    taskId: task.taskId,
    purpose: 'Accept coding task and create bounded lead loop state.',
    summary: `Accepted coding task ${task.taskId}.`,
    evidence: [
      sessionPlan.leadSessionName,
      `workspaceRoot=${workspaceTarget.workspaceRoot}`,
      `scope=${workspaceTarget.projectRelativePath}`,
      `maxTurns=${maxTurns}`,
    ],
  });

  const preflightRunner = dependencies.preflight ?? ((scopePath: string) => runCodingRepoPreflight(scopePath));
  const preflight = preflightRunner(workspaceTarget.scopePath, workspaceTarget);

  let state = createInitialLoopState(task, sessionPlan, preflight, maxTurns);
  await persistLoopCheckpoint(taskRunStore, state, reporter, createdAt);

  try {
    while (state.turn < state.maxTurns) {
      state.turn += 1;
      const step = state.currentStep;

      if (step === 'triage') {
        await runTriageStep(state, dependencies);
      } else if (step === 'implement') {
        await runImplementStep(state, dependencies);
      } else if (step === 'test-debug') {
        await runTestDebugStep(state, dependencies);
      } else if (step === 'code-review') {
        await runCodeReviewStep(state, dependencies);
      } else if (step === 'github') {
        await runGithubStep(state, dependencies);
      } else if (step === 'completed' || step === 'blocked' || step === 'error') {
        break;
      }

      await persistLoopCheckpoint(taskRunStore, state, reporter, createdAt);
    }

    if (state.turn >= state.maxTurns && state.currentStep !== 'completed' && state.currentStep !== 'blocked') {
      state.currentStep = 'blocked';
      state.lastFailureSummary = `Exceeded maximum loop turns (${state.maxTurns}).`;
      reporter.emit({
        type: 'coding.blocked',
        taskId: task.taskId,
        risk: 'Coding worker exceeded the bounded turn guard without completing.',
        summary: state.lastFailureSummary,
        nextAction: 'Break the task into smaller chunks or raise the turn limit.',
      });
    }

    if (state.currentStep === 'completed') {
      reporter.emit({
        type: 'coding.completed',
        taskId: task.taskId,
        summary: 'Coding worker completed with required verification evidence.',
        evidence: state.verificationResults.evidence.map((item) => `${item.command}: ${item.status}`),
      });
    }

    const result = createLoopResult(state, reporter);
    await persistLoopCheckpoint(taskRunStore, state, reporter, createdAt);
    return result;
  } catch (error) {
    const errorSummary = error instanceof Error ? error.message : String(error);
    state.currentStep = 'error';
    state.lastFailureSummary = errorSummary;
    reporter.emit({
      type: 'coding.error',
      taskId: task.taskId,
      risk: 'Coding worker loop failed with an unhandled error.',
      summary: `Coding worker loop failed: ${errorSummary}`,
      evidence: [errorSummary],
    });
    await persistLoopCheckpoint(taskRunStore, state, reporter, createdAt);
    throw error;
  }
}

export function createInitialLoopState(
  task: CodingWorkerTaskRequest,
  sessionPlan: CodingWorkerSessionPlan,
  preflight: CodingRepoPreflight,
  maxTurns: number,
): CodingWorkerLoopState {
  const plan = createInitialPlan(task, {
    preflight,
    filesToInspect: task.filesToInspect,
    github: task.github,
  });
  return {
    task,
    sessionPlan,
    preflight,
    currentStep: 'triage',
    turn: 0,
    maxTurns,
    plan,
    approvalQueue: [],
    pendingEdits: {
      fileEdits: [],
      writeFiles: [],
    },
    verificationResults: {
      requiredCommands: resolveVerificationCommands(task.verificationCommands, preflight),
      evidence: [],
    },
    subagentHistory: [],
    replanCount: 0,
  };
}

export function createLoopCheckpoint(state: CodingWorkerLoopState): CodingWorkerLoopCheckpoint {
  return {
    taskId: state.task.taskId,
    status: statusFromStep(state.currentStep),
    currentStep: state.currentStep,
    turn: state.turn,
    maxTurns: state.maxTurns,
    plan: state.plan.map((item) => ({ ...item })),
    approvalQueue: state.approvalQueue.map((item) => ({ ...item })),
    pendingEdits: {
      fileEdits: state.pendingEdits.fileEdits.map((edit) => ({ ...edit })),
      writeFiles: state.pendingEdits.writeFiles.map((write) => ({ ...write })),
    },
    verificationResults: {
      requiredCommands: state.verificationResults.requiredCommands.map((command) => ({ ...command })),
      evidence: state.verificationResults.evidence.map((item) => ({ ...item })),
    },
    subagentHistory: state.subagentHistory.map((result) => ({ ...result })),
    replanCount: state.replanCount,
    ...(state.lastFailureSummary ? { lastFailureSummary: state.lastFailureSummary } : {}),
  };
}

async function runTriageStep(
  state: CodingWorkerLoopState,
  dependencies: CodingWorkerLoopDependencies,
): Promise<void> {
  const reporter = dependencies.reporter ?? new InMemoryCodingProgressReporter();
  setPlanStatus(state.plan, 'triage', 'in_progress');
  reporter.emit({
    type: 'coding.triage.started',
    taskId: state.task.taskId,
    subagent: 'triage',
    purpose: 'Run worker-local triage subagent to classify task and build plan.',
    evidence: [state.task.sessionId ?? 'default'],
  });

  const request = buildSubagentRequest(state);
  const result = await callSubagentDelegate('triage', request, dependencies);
  state.subagentHistory.push(result);

  if (result.structuredOutput?.type === 'triage') {
    const triageResult = result.structuredOutput.result;
    if (triageResult.plan.length > 0) {
      state.plan = mergePlan(state.plan, triageResult.plan);
    }
    if (triageResult.filesToInspect.length > 0 && !state.task.filesToInspect) {
      state.task.filesToInspect = triageResult.filesToInspect;
    }
  }

  reporter.emit({
    type: 'coding.plan.updated',
    taskId: state.task.taskId,
    purpose: 'Make the worker-local subagent plan visible before execution.',
    plan: state.plan,
    summary: 'Initial coding-worker plan created.',
  });

  setPlanStatus(state.plan, 'triage', 'completed');
  reporter.emit({
    type: 'coding.triage.completed',
    taskId: state.task.taskId,
    subagent: 'triage',
    summary: result.summary,
    evidence: result.evidence,
    nextAction: result.nextAction ?? 'Proceed to implementation.',
    plan: state.plan,
  });

  state.currentStep = chooseNextStep(state, 'implement');
}

async function runImplementStep(
  state: CodingWorkerLoopState,
  dependencies: CodingWorkerLoopDependencies,
): Promise<void> {
  const reporter = dependencies.reporter ?? new InMemoryCodingProgressReporter();
  setPlanStatus(state.plan, 'implementer', 'in_progress');
  reporter.emit({
    type: 'coding.implementer.started',
    taskId: state.task.taskId,
    subagent: 'implementer',
    purpose: 'Run worker-local implementer subagent to produce scoped edits.',
  });

  const request = buildSubagentRequest(state);
  const result = await callSubagentDelegate('implementer', request, dependencies);
  state.subagentHistory.push(result);

  if (result.structuredOutput?.type === 'implementer') {
    const implementerResult = result.structuredOutput.result;
    state.pendingEdits.fileEdits.push(...implementerResult.fileEdits);
    state.pendingEdits.writeFiles.push(...implementerResult.writeFiles);

    const incomingCommands = resolveVerificationCommands(
      implementerResult.verificationCommands,
      state.preflight,
    );
    state.verificationResults.requiredCommands = mergeVerificationCommands(
      state.verificationResults.requiredCommands,
      incomingCommands,
    );
  }

  const sandbox = await getSandbox(state, dependencies);
  const applied = await applyPendingEditsWithApproval(state, sandbox, dependencies);
  if (!applied) {
    setPlanStatus(state.plan, 'implementer', 'blocked');
    reporter.emit({
      type: 'coding.approval.requested',
      taskId: state.task.taskId,
      action: 'file.edit',
      summary: 'Pending file edits require approval before application.',
      risk: 'Applying edits mutates workspace files.',
    });
    state.currentStep = 'blocked';
    return;
  }

  setPlanStatus(state.plan, 'implementer', 'completed');
  reporter.emit({
    type: 'coding.implementer.completed',
    taskId: state.task.taskId,
    subagent: 'implementer',
    summary: result.summary,
    evidence: result.evidence,
    nextAction: result.nextAction ?? 'Run focused and required verification.',
  });

  state.currentStep = chooseNextStep(state, 'test-debug');
}

async function runTestDebugStep(
  state: CodingWorkerLoopState,
  dependencies: CodingWorkerLoopDependencies,
): Promise<void> {
  const reporter = dependencies.reporter ?? new InMemoryCodingProgressReporter();
  setPlanStatus(state.plan, 'test-debug', 'in_progress');
  reporter.emit({
    type: 'coding.test-debug.started',
    taskId: state.task.taskId,
    subagent: 'test-debug',
    purpose: 'Run focused and required verification through the local sandbox.',
  });

  const sandbox = await getSandbox(state, dependencies);
  let passing = await runVerification(state, sandbox, reporter);

  if (!passing) {
    const request = buildSubagentRequest(state);
    const result = await callSubagentDelegate('test-debug', request, dependencies);
    state.subagentHistory.push(result);

    if (result.structuredOutput?.type === 'test-debug') {
      const testDebugResult = result.structuredOutput.result;
      const incomingCommands = resolveVerificationCommands(
        testDebugResult.verificationCommands,
        state.preflight,
      );
      state.verificationResults.requiredCommands = mergeVerificationCommands(
        state.verificationResults.requiredCommands,
        incomingCommands,
      );

      if (testDebugResult.debugEdits.length > 0) {
        state.pendingEdits.fileEdits.push(...testDebugResult.debugEdits);
        const applied = await applyPendingEditsWithApproval(state, sandbox, dependencies);
        if (!applied) {
          setPlanStatus(state.plan, 'test-debug', 'blocked');
          reporter.emit({
            type: 'coding.approval.requested',
            taskId: state.task.taskId,
            action: 'file.edit',
            summary: 'Debug edits require approval before application.',
            risk: 'Applying debug edits mutates workspace files.',
          });
          state.currentStep = 'blocked';
          return;
        }
        passing = await runVerification(state, sandbox, reporter);
      }
    }
  }

  if (!passing) {
    const maxReplans = dependencies.maxReplans ?? DEFAULT_MAX_REPLANS;
    state.replanCount += 1;

    if (state.replanCount > maxReplans) {
      state.lastFailureSummary = `Required verification commands did not pass and the replan budget (${maxReplans}) is exhausted.`;
      reporter.emit({
        type: 'coding.blocked',
        taskId: state.task.taskId,
        step: 'test-debug',
        risk: state.lastFailureSummary,
        summary: state.lastFailureSummary,
        nextAction: 'Human review is required; the loop cannot auto-resolve repeated verification failures.',
      });
      state.currentStep = 'blocked';
      return;
    }

    state.lastFailureSummary = 'Coding worker cannot complete without passing required verification evidence.';
    state.plan = replan(state, {
      step: 'test-debug',
      summary: state.lastFailureSummary,
      verificationEvidence: state.verificationResults.evidence,
    });
    reporter.emit({
      type: 'coding.plan.updated',
      taskId: state.task.taskId,
      purpose: 'Update the worker-local plan after verification failure.',
      plan: state.plan,
      summary: 'Plan updated with verification failure context.',
    });
    reporter.emit({
      type: 'coding.blocked',
      taskId: state.task.taskId,
      step: 'test-debug',
      risk: 'Required verification commands did not pass; no debug fix resolved them.',
      summary: state.lastFailureSummary,
      nextAction: 'Provide passing verification commands or fix the underlying failure.',
    });
    state.currentStep = 'blocked';
    return;
  }

  setPlanStatus(state.plan, 'test-debug', 'completed');
  reporter.emit({
    type: 'coding.test-debug.completed',
    taskId: state.task.taskId,
    subagent: 'test-debug',
    summary: 'Verification passed.',
    evidence: state.verificationResults.evidence.map((item) => `${item.command}: ${item.status}`),
    nextAction: 'Proceed to independent code review.',
  });

  state.currentStep = chooseNextStep(state, 'code-review');
}

async function runCodeReviewStep(
  state: CodingWorkerLoopState,
  dependencies: CodingWorkerLoopDependencies,
): Promise<void> {
  const reporter = dependencies.reporter ?? new InMemoryCodingProgressReporter();
  setPlanStatus(state.plan, 'code-review', 'in_progress');
  reporter.emit({
    type: 'coding.review.started',
    taskId: state.task.taskId,
    subagent: 'code-review',
    purpose: 'Run independent code review over the diff and verification evidence.',
  });

  const request = buildSubagentRequest(state);
  const result = await callSubagentDelegate('code-review', request, dependencies);
  state.subagentHistory.push(result);

  if (result.structuredOutput?.type === 'code-review') {
    const reviewResult = result.structuredOutput.result;
    if (!reviewResult.approved) {
      const maxReplans = dependencies.maxReplans ?? DEFAULT_MAX_REPLANS;
      state.replanCount += 1;

      if (state.replanCount > maxReplans) {
        state.lastFailureSummary = `Code review rejected the change and the replan budget (${maxReplans}) is exhausted.`;
        setPlanStatus(state.plan, 'code-review', 'blocked');
        reporter.emit({
          type: 'coding.blocked',
          taskId: state.task.taskId,
          step: 'code-review',
          summary: state.lastFailureSummary,
          risk: reviewResult.findings.map((finding) => finding.message).join('; '),
          nextAction: 'Human review is required; the loop cannot auto-resolve repeated rejections.',
        });
        state.currentStep = 'blocked';
        return;
      }

      state.plan = replan(state, {
        step: 'code-review',
        summary: 'Code review rejected the change; replanning from implementation.',
        reviewFindings: reviewResult.findings,
      });
      reporter.emit({
        type: 'coding.plan.updated',
        taskId: state.task.taskId,
        purpose: 'Update the worker-local plan after code-review rejection.',
        plan: state.plan,
        summary: 'Plan updated with code-review findings.',
      });
      reporter.emit({
        type: 'coding.replanned',
        taskId: state.task.taskId,
        step: 'code-review',
        summary: 'Code review rejected the change; replanning from implementation.',
        risk: reviewResult.findings.map((finding) => finding.message).join('; '),
        nextAction: 'Address review findings and re-run verification.',
      });
      state.currentStep = 'implement';
      return;
    }
  }

  setPlanStatus(state.plan, 'code-review', 'completed');
  reporter.emit({
    type: 'coding.review.completed',
    taskId: state.task.taskId,
    subagent: 'code-review',
    summary: result.summary,
    evidence: result.evidence,
    nextAction: result.nextAction ?? 'Proceed to GitHub surface or completion.',
  });

  state.currentStep = chooseNextStep(state, 'github');
}

async function runGithubStep(
  state: CodingWorkerLoopState,
  dependencies: CodingWorkerLoopDependencies,
): Promise<void> {
  const reporter = dependencies.reporter ?? new InMemoryCodingProgressReporter();
  setPlanStatus(state.plan, 'github', 'in_progress');
  reporter.emit({
    type: 'coding.github.started',
    taskId: state.task.taskId,
    subagent: 'github',
    purpose: 'Gather GitHub context and prepare approval-gated remote actions.',
  });

  const request = buildSubagentRequest(state);
  const result = await callSubagentDelegate('github', request, dependencies);
  state.subagentHistory.push(result);

  if (result.structuredOutput?.type === 'github') {
    const githubResult = result.structuredOutput.result;
    for (const action of githubResult.actions) {
      reporter.emit({
        type: 'coding.github.action_completed',
        taskId: state.task.taskId,
        action: action.action,
        summary: `GitHub action ${action.action} prepared.`,
        evidence: [JSON.stringify(action.payload)],
      });
    }
  }

  setPlanStatus(state.plan, 'github', 'completed');
  reporter.emit({
    type: 'coding.github.completed',
    taskId: state.task.taskId,
    subagent: 'github',
    summary: result.summary,
    evidence: result.evidence,
    nextAction: result.nextAction ?? 'Return structured completion status.',
  });

  state.currentStep = 'completed';
}

async function callSubagentDelegate(
  subagent: CodingSubagentKind,
  request: CodingTaskSubagentRequest,
  dependencies: CodingWorkerLoopDependencies,
): Promise<CodingSubagentRunResult> {
  if (dependencies.delegate) {
    return dependencies.delegate(subagent, request);
  }

  throw new Error(
    `Coding worker loop cannot call ${subagent} subagent without a delegate. ` +
      'Provide a delegate that uses Flue session.task delegation.',
  );
}

async function applyPendingEditsWithApproval(
  state: CodingWorkerLoopState,
  sandbox: CodingSandboxRuntime,
  dependencies: CodingWorkerLoopDependencies,
): Promise<boolean> {
  if (state.pendingEdits.fileEdits.length === 0 && state.pendingEdits.writeFiles.length === 0) {
    return true;
  }

  const approvalService = dependencies.approvalService;
  if (!approvalService) {
    throw new Error('Coding worker loop requires an approval service to apply file edits.');
  }

  const targetPaths = [
    ...state.pendingEdits.fileEdits.map((edit) => edit.path),
    ...state.pendingEdits.writeFiles.map((write) => write.path),
  ];
  const dedupeKey = createEditApprovalDedupeKey(state.task.taskId, targetPaths);
  const existing = (await approvalService.listRecords(state.task.taskId)).find(
    (record) => record.request.dedupeKey === dedupeKey,
  );
  if (existing?.status === 'approved') {
    await applyPendingEdits(state, sandbox);
    return true;
  }

  const request = createCodingApprovalRequest({
    taskId: state.task.taskId,
    actionType: 'file.edit',
    summary: `Apply ${state.pendingEdits.fileEdits.length} edit(s) and ${state.pendingEdits.writeFiles.length} write(s).`,
    reason: 'Applying edits mutates workspace files under the coding-worker scope.',
    risk: 'This changes source files in the selected project/repo.',
    target: targetPaths.join(', '),
    metadata: {
      fileEditCount: state.pendingEdits.fileEdits.length,
      writeFileCount: state.pendingEdits.writeFiles.length,
    },
    dedupeKey,
  });

  state.approvalQueue.push({
    requestId: request.id,
    actionType: request.actionType,
    summary: request.summary,
    status: 'pending',
  });

  const evaluation = await approvalService.evaluateRequest(request);
  if (!evaluation.allowed) {
    return false;
  }

  await applyPendingEdits(state, sandbox);
  const queueItem = state.approvalQueue.find((item) => item.requestId === request.id);
  if (queueItem) {
    queueItem.status = 'approved';
  }
  return true;
}

async function applyPendingEdits(state: CodingWorkerLoopState, sandbox: CodingSandboxRuntime): Promise<CodingEditTransaction> {
  const transaction = createCodingEditTransaction(
    `pending:${state.task.taskId}:${Date.now()}`,
    state.pendingEdits.fileEdits,
    state.pendingEdits.writeFiles,
  );
  const result = await applyCodingEditTransaction(sandbox, transaction);

  if (result.status === 'applied') {
    state.pendingEdits.fileEdits = [];
    state.pendingEdits.writeFiles = [];
    return result;
  }

  const failurePath = result.failure?.path ?? 'unknown';
  const failureReason = result.failure?.reason ?? 'unknown';
  throw new Error(`Edit transaction failed on ${failurePath}: ${failureReason}`);
}

async function runVerification(
  state: CodingWorkerLoopState,
  sandbox: CodingSandboxRuntime,
  reporter: CodingProgressReporter,
): Promise<boolean> {
  const commands = state.verificationResults.requiredCommands;
  let allPassing = true;

  for (const command of commands) {
    reporter.emit({
      type: 'coding.verification.started',
      taskId: state.task.taskId,
      command: command.command,
      summary: `Running verification: ${command.command}`,
    });

    const loopCommand = command as LoopVerificationCommand;
    const policy = evaluateCodingShellCommand(command.command);
    let evidence: CodingVerificationEvidence;

    if (!policy.allowed) {
      evidence = {
        command: command.command,
        status: 'failed',
        exitCode: 1,
        summary: policy.reason ?? 'Command blocked by coding-worker command policy.',
      };
    } else {
      const shellResult = await sandbox.exec(command.command, {
        cwd: loopCommand.cwd,
        timeoutSeconds: loopCommand.timeoutSeconds ?? 120,
      });
      const status = shellResult.exitCode === 0 ? 'passed' : 'failed';
      const summary = summarizeShellResult(shellResult.stdout, shellResult.stderr);
      const parsed =
        status === 'failed'
          ? parseVerificationCommandFailures(command, shellResult.stdout, shellResult.stderr)
          : undefined;
      evidence = {
        command: command.command,
        status,
        exitCode: shellResult.exitCode,
        summary,
        ...(parsed
          ? {
              failures: parsed.failures,
              parser: parsed.parser,
            }
          : {}),
      };
    }

    state.verificationResults.evidence.push(evidence);
    command.status = evidence.status;

    reporter.emit({
      type: 'coding.verification.completed',
      taskId: state.task.taskId,
      command: command.command,
      status: evidence.status,
      summary: evidence.summary,
    });

    if (command.required && evidence.status !== 'passed') {
      allPassing = false;
    }
  }

  return allPassing;
}

function buildSubagentRequest(state: CodingWorkerLoopState): CodingTaskSubagentRequest {
  return {
    task: state.task,
    sessionPlan: state.sessionPlan,
    preflight: state.preflight,
    plan: state.plan,
    verificationEvidence: state.verificationResults.evidence,
  };
}

function createEditApprovalDedupeKey(taskId: string, paths: string[]): string {
  return `${taskId}:file.edit:${paths.sort().join('|')}`;
}

function groupEditsByPath(edits: CodingFileEdit[]): Map<string, CodingFileEdit[]> {
  const map = new Map<string, CodingFileEdit[]>();
  for (const edit of edits) {
    const list = map.get(edit.path) ?? [];
    list.push(edit);
    map.set(edit.path, list);
  }
  return map;
}

function mergePlan(existingPlan: CodingPlanItem[], incomingPlan: CodingPlanItem[]): CodingPlanItem[] {
  const byId = new Map(existingPlan.map((item) => [item.id, item]));
  for (const item of incomingPlan) {
    byId.set(item.id, item);
  }
  return [...byId.values()];
}

function mergeVerificationCommands(
  existing: LoopVerificationCommand[],
  incoming: LoopVerificationCommand[],
): LoopVerificationCommand[] {
  const byName = new Map(existing.map((command) => [command.name, command]));
  for (const command of incoming) {
    if (!byName.has(command.name)) {
      byName.set(command.name, command);
    }
  }
  return [...byName.values()];
}

function resolveVerificationCommands(
  requestedCommands: CodingVerificationCommandRequest[] | undefined,
  preflight: CodingRepoPreflight,
): LoopVerificationCommand[] {
  if (!requestedCommands?.length) {
    return preflight.verificationPlan.map((command) => ({ ...command }));
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

function chooseNextStep(state: CodingWorkerLoopState, defaultStep: CodingWorkerLoopStep): CodingWorkerLoopStep {
  if (state.currentStep === 'blocked' || state.currentStep === 'error') {
    return state.currentStep;
  }

  if (defaultStep === 'github' && !shouldUseGithub(state.task)) {
    return 'completed';
  }

  return defaultStep;
}

function shouldUseGithub(task: CodingWorkerTaskRequest): boolean {
  return Boolean(task.github?.issueNumber || task.github?.pullRequestNumber || task.github?.url);
}

function statusFromStep(step: CodingWorkerLoopStep): CodingWorkerRunStatus {
  switch (step) {
    case 'completed':
      return 'completed';
    case 'blocked':
      return 'blocked';
    case 'error':
      return 'failed';
    default:
      return 'needs_approval';
  }
}

function createLoopResult(state: CodingWorkerLoopState, reporter: CodingProgressReporter): CodingWorkerRunResult {
  const status = statusFromStep(state.currentStep);
  const summary =
    status === 'completed'
      ? 'Coding worker completed with required verification evidence.'
      : status === 'blocked'
        ? state.lastFailureSummary ?? 'Coding worker is blocked awaiting approval or context.'
        : state.lastFailureSummary ?? 'Coding worker loop finished.';

  return {
    taskId: state.task.taskId,
    status,
    summary,
    plan: state.plan,
    subagentResults: state.subagentHistory,
    verification: {
      requiredCommands: state.verificationResults.requiredCommands,
      evidence: state.verificationResults.evidence,
    },
    publicEvents: createOrchestratorProgressUpdate(state.task.taskId, reporter.events()).events,
    artifacts: [],
    checkpoint: createLoopCheckpoint(state),
  };
}

async function persistLoopCheckpoint(
  store: CodingTaskRunStore,
  state: CodingWorkerLoopState,
  reporter: CodingProgressReporter,
  createdAt: string,
): Promise<void> {
  await store.upsert({
    taskId: state.task.taskId,
    status: checkpointStatusForStep(state.currentStep),
    sessionPlan: state.sessionPlan,
    plan: state.plan,
    events: reporter.events(),
    verificationEvidence: state.verificationResults.evidence,
    checkpoint: createLoopCheckpoint(state),
    createdAt,
    updatedAt: new Date().toISOString(),
  });
}

function checkpointStatusForStep(step: CodingWorkerLoopStep): import('../session/task-run-store.js').CodingTaskRunStatus {
  switch (step) {
    case 'triage':
      return 'triaging';
    case 'implement':
      return 'implementing';
    case 'test-debug':
      return 'testing';
    case 'code-review':
      return 'reviewing';
    case 'github':
      return 'github';
    case 'completed':
      return 'completed';
    case 'blocked':
      return 'blocked';
    case 'error':
      return 'failed';
    default:
      return 'accepted';
  }
}

async function getSandbox(
  state: CodingWorkerLoopState,
  dependencies: CodingWorkerLoopDependencies,
): Promise<CodingSandboxRuntime> {
  if (dependencies.sandbox) {
    return dependencies.sandbox;
  }

  const target = resolveCodingWorkspaceTarget(state.task);
  const createSandbox = dependencies.createSandbox ?? createDefaultSandbox;
  return createSandbox(target, state.sessionPlan);
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

function summarizeShellResult(stdout: string, stderr: string): string {
  const combined = `${stdout}\n${stderr}`.trim();
  return combined ? combined.slice(0, 1_000) : 'Command produced no output.';
}

export function createCodingWorkerLoopDelegate(session: { task: FlueSession['task'] }) {
  return createFlueCodingSubagentDelegate(session);
}

export { createInitialCodingPlan, chooseSubagents, replan };
