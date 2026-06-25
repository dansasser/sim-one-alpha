import { createCodingApprovalRequest } from '../../../../engine/workers/coding-worker/approvals/approval-policy.js';
import type { CodingProgressReporter } from '../../../../engine/workers/coding-worker/events/progress-reporter.js';
import { runCodingRepoPreflight, type CodingRepoPreflight } from '../../../../engine/workers/coding-worker/repo/preflight.js';
import {
  createFlueLocalCodingSandbox,
  type CodingSandboxRuntime,
} from '../../../../engine/workers/coding-worker/tools/sandbox-runtime.js';
import {
  resolveCodingWorkspaceTarget,
  type ResolvedCodingWorkspaceTarget,
} from '../../../../engine/workers/coding-worker/repo/workspace-target.js';
import { createCodingWorkerSessionPlan, type CodingWorkerSessionPlan } from '../../../../engine/workers/coding-worker/session/child-session-names.js';
import type {
  CodingFileEdit,
  CodingPlanItem,
  CodingSubagentKind,
  CodingVerificationCommand,
  CodingVerificationCommandRequest,
  CodingVerificationEvidence,
  CodingWorkerTaskRequest,
} from '../../../../engine/workers/coding-worker/types.js';
import { createInitialPlan, type PlanningContext } from '../../../../engine/workers/coding-worker/workflow/planning.js';

export interface CodingTaskWorkflowDependencies {
  preflight?: (scopePath: string, target: ResolvedCodingWorkspaceTarget) => CodingRepoPreflight;
  reporter?: CodingProgressReporter;
  sandbox?: CodingSandboxRuntime;
  createSandbox?: (
    target: ResolvedCodingWorkspaceTarget,
    sessionPlan: CodingWorkerSessionPlan,
  ) => Promise<CodingSandboxRuntime>;
  delegate?: (subagent: CodingSubagentKind, request: CodingTaskSubagentRequest) => Promise<unknown>;
  verificationEvidence?: CodingVerificationEvidence[];
}

export interface CodingTaskSubagentRequest {
  task: CodingWorkerTaskRequest;
  sessionPlan: CodingWorkerSessionPlan;
  preflight: CodingRepoPreflight;
  plan: CodingPlanItem[];
  verificationEvidence?: CodingVerificationEvidence[];
}

interface WorkflowVerificationCommand extends CodingVerificationCommand {
  cwd?: string;
  timeoutSeconds?: number;
}

/**
 * @deprecated Use `createInitialPlan` from `./planning.js` for context-aware planning.
 */
export function createInitialCodingPlan(task: CodingWorkerTaskRequest): CodingPlanItem[] {
  return createInitialPlan(task);
}

export { createInitialPlan, type PlanningContext };

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

export function setPlanStatus(
  plan: CodingPlanItem[],
  owner: CodingPlanItem['owner'],
  status: CodingPlanItem['status'],
): void {
  const item = plan.find((entry) => entry.owner === owner);
  if (item) {
    item.status = status;
  }
}

export function resolveVerificationCommands(
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

export async function createDefaultSandbox(
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
