import type { CodingRepoPreflight } from '../../../../engine/workers/coding-worker/repo/preflight.js';
import type {
  CodingCodeReviewFinding,
  CodingPlanItem,
  CodingVerificationEvidence,
  CodingWorkerLoopState,
  CodingWorkerLoopStep,
  CodingWorkerTaskRequest,
} from '../../../../engine/workers/coding-worker/types.js';

export interface PlanningContext {
  /** Repository preflight context used to enrich plan descriptions. */
  preflight?: { repoPath?: string; packageManager?: string };
  /** Files the triage subagent identified as relevant context. */
  filesToInspect?: string[];
  /** GitHub context that may add a GitHub stage to the plan. */
  github?: { issueNumber?: number; pullRequestNumber?: number; url?: string };
}

export interface ReplanFailureContext {
  /** The loop step that triggered replanning. */
  step: CodingWorkerLoopStep;
  /** Human-readable summary of the failure or new context. */
  summary: string;
  /** Code-review findings when the rejection drove replanning. */
  reviewFindings?: CodingCodeReviewFinding[];
  /** Verification evidence when a failed check drove replanning. */
  verificationEvidence?: CodingVerificationEvidence[];
}

const ownerForStep = new Map<CodingWorkerLoopStep, CodingPlanItem['owner']>([
  ['triage', 'triage'],
  ['implement', 'implementer'],
  ['test-debug', 'test-debug'],
  ['code-review', 'code-review'],
  ['github', 'github'],
]);

/**
 * Build the initial worker-local plan from the task request and optional context.
 *
 * The plan is explicit: each item has an owner subagent (or the lead), a stable
 * id, and a description that includes the context that shaped it. GitHub context
 * adds a GitHub stage; files to inspect are surfaced in the triage item.
 */
export function createInitialPlan(
  task: CodingWorkerTaskRequest,
  context: PlanningContext = {},
): CodingPlanItem[] {
  const hasGithub = Boolean(
    context.github?.issueNumber ||
      context.github?.pullRequestNumber ||
      context.github?.url ||
      task.github?.issueNumber ||
      task.github?.pullRequestNumber ||
      task.github?.url,
  );
  const filesToInspect = context.filesToInspect ?? task.filesToInspect ?? [];
  const packageManager = context.preflight?.packageManager;

  const triageDescription =
    filesToInspect.length > 0
      ? `Triage request, workspace/project scope, repository state, GitHub context, and required internal subagents. Files to inspect: ${filesToInspect.join(', ')}.`
      : 'Triage request, workspace/project scope, repository state, GitHub context, and required internal subagents.';

  const implementationDescription = packageManager
    ? `Implement scoped changes through the coding-worker local sandbox. Preferred package manager: ${packageManager}.`
    : 'Implement scoped changes through the coding-worker local sandbox when required.';

  const plan: CodingPlanItem[] = [
    {
      id: `${task.taskId}:triage`,
      description: triageDescription,
      owner: 'triage',
      status: 'pending',
    },
    {
      id: `${task.taskId}:implementation`,
      description: implementationDescription,
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

  if (hasGithub) {
    plan.push({
      id: `${task.taskId}:github`,
      description: 'Gather GitHub context and prepare approval-gated remote actions.',
      owner: 'github',
      status: 'pending',
    });
  }

  return plan;
}

/**
 * Replan the worker-local loop state after a failure or when new context is
 * discovered.
 *
 * Returns a new plan array that:
 * - Marks the step that failed as blocked (or in_progress if it should be retried).
 * - Records the replan action as a lead-owned item.
 * - Surfaces review findings as implementer-owned plan items.
 * - Surfaces failed verification evidence as test-debug-owned items.
 */
export function replan(
  state: CodingWorkerLoopState,
  failureContext: ReplanFailureContext,
): CodingPlanItem[] {
  const plan = state.plan.map((item) => ({ ...item }));
  const replanNumber = state.replanCount + 1;
  const replanId = `${state.task.taskId}:replan-${replanNumber}`;

  const failedOwner = ownerForStep.get(failureContext.step);
  if (failedOwner) {
    const failedItem = plan.find((item) => item.owner === failedOwner);
    if (failedItem) {
      failedItem.status = 'blocked';
    }
  }

  plan.push({
    id: replanId,
    description: `Replan after ${failureContext.step} failure: ${failureContext.summary}`,
    owner: 'coding-worker',
    status: 'completed',
  });

  if (failureContext.reviewFindings && failureContext.reviewFindings.length > 0) {
    for (let index = 0; index < failureContext.reviewFindings.length; index += 1) {
      const finding = failureContext.reviewFindings[index];
      if (finding.severity !== 'blocker') {
        continue;
      }
      const location = finding.file
        ? ` (${finding.file}${finding.lineStart !== undefined ? `:${finding.lineStart}` : ''})`
        : '';
      plan.push({
        id: `${replanId}:finding-${index}`,
        description: `[${finding.severity}] ${finding.message}${location}`,
        owner: 'implementer',
        status: 'pending',
      });
    }

    const implementerItem = plan.find((item) => item.owner === 'implementer');
    if (implementerItem) {
      implementerItem.status = 'in_progress';
    }
  }

  const failedEvidence = failureContext.verificationEvidence?.filter((item) => item.status === 'failed') ?? [];
  if (failedEvidence.length > 0) {
    for (let index = 0; index < failedEvidence.length; index += 1) {
      const evidence = failedEvidence[index];
      plan.push({
        id: `${replanId}:verify-${index}`,
        description: `Investigate verification failure: ${evidence.command} (${evidence.summary.slice(0, 120)})`,
        owner: 'test-debug',
        status: 'pending',
      });
    }

    const testDebugItem = plan.find((item) => item.owner === 'test-debug');
    if (testDebugItem) {
      testDebugItem.status = 'in_progress';
    }
  }

  return plan;
}
