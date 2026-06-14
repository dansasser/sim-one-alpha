import { defineTool, Type, type ToolDefinition } from '@flue/runtime';
import type { CodingProgressReporter } from '../events/progress-reporter.js';
import type { CodingWorkerEventType } from '../events/coding-worker-events.js';
import type {
  CodingCodeReviewFinding,
  CodingPlanItem,
  CodingVerificationEvidence,
  CodingWorkerLoopState,
  CodingWorkerLoopStep,
} from '../types.js';
import { createInitialPlan, replan, type PlanningContext, type ReplanFailureContext } from '../workflow/planning.js';

const CodingWorkerLoopStepSchema = Type.Union([
  Type.Literal('triage'),
  Type.Literal('implement'),
  Type.Literal('test-debug'),
  Type.Literal('code-review'),
  Type.Literal('github'),
  Type.Literal('commit'),
  Type.Literal('push'),
  Type.Literal('pr'),
  Type.Literal('replanned'),
  Type.Literal('completed'),
  Type.Literal('blocked'),
  Type.Literal('error'),
]);

export interface CodingPlanningToolsOptions {
  reporter?: CodingProgressReporter;
  taskId?: string;
}

export function createCodingPlanningTools(options: CodingPlanningToolsOptions = {}): ToolDefinition[] {
  return [
    defineTool({
      name: 'coding_plan_create',
      description:
        'Create an explicit initial worker-local plan for a coding task. Returns CodingPlanItem[] with owners, descriptions, and statuses.',
      parameters: Type.Object({
        taskId: Type.String(),
        text: Type.String(),
        filesToInspect: Type.Optional(Type.Array(Type.String())),
        hasGithubContext: Type.Optional(Type.Boolean()),
        packageManager: Type.Optional(Type.String()),
      }),
      execute: async (args) => {
        const task = {
          taskId: args.taskId,
          text: args.text,
          ...(args.filesToInspect ? { filesToInspect: args.filesToInspect } : {}),
          ...(args.hasGithubContext ? { github: {} } : {}),
        };
        const context: PlanningContext = {};
        if (args.packageManager) {
          context.preflight = { packageManager: args.packageManager };
        }
        if (args.filesToInspect) {
          context.filesToInspect = args.filesToInspect;
        }
        if (args.hasGithubContext) {
          context.github = {};
        }
        const plan = createInitialPlan(task, context);
        emitToolProgress(options, {
          type: 'coding.plan.updated',
          summary: `Created initial plan with ${plan.length} item(s).`,
          plan,
        });
        return JSON.stringify({ plan }, null, 2);
      },
    }),
    defineTool({
      name: 'coding_plan_replan',
      description:
        'Replan the worker-local loop after a failure or when new context is discovered. Returns an updated CodingPlanItem[].',
      parameters: Type.Object({
        taskId: Type.String(),
        currentStep: CodingWorkerLoopStepSchema,
        turn: Type.Number(),
        maxTurns: Type.Number(),
        replanCount: Type.Number(),
        plan: Type.Array(
          Type.Object({
            id: Type.String(),
            description: Type.String(),
            owner: Type.Union([
              Type.Literal('triage'),
              Type.Literal('implementer'),
              Type.Literal('test-debug'),
              Type.Literal('code-review'),
              Type.Literal('github'),
              Type.Literal('coding-worker'),
            ]),
            status: Type.Union([
              Type.Literal('pending'),
              Type.Literal('in_progress'),
              Type.Literal('completed'),
              Type.Literal('blocked'),
            ]),
          })
        ),
        failureStep: CodingWorkerLoopStepSchema,
        failureSummary: Type.String(),
        reviewFindings: Type.Optional(
          Type.Array(
            Type.Object({
              file: Type.Optional(Type.String()),
              lineStart: Type.Optional(Type.Number()),
              lineEnd: Type.Optional(Type.Number()),
              severity: Type.Union([Type.Literal('info'), Type.Literal('warning'), Type.Literal('blocker')]),
              message: Type.String(),
            })
          )
        ),
        verificationEvidence: Type.Optional(
          Type.Array(
            Type.Object({
              command: Type.String(),
              status: Type.Union([Type.Literal('passed'), Type.Literal('failed'), Type.Literal('skipped')]),
              exitCode: Type.Optional(Type.Number()),
              summary: Type.String(),
            })
          )
        ),
      }),
      execute: async (args) => {
        const replanArgs = args as ReplanToolArgs;
        const state = buildLoopStateFromToolArgs(replanArgs);
        const failureContext: ReplanFailureContext = {
          step: replanArgs.failureStep,
          summary: replanArgs.failureSummary,
          reviewFindings: replanArgs.reviewFindings,
          verificationEvidence: replanArgs.verificationEvidence,
        };
        const plan = replan(state, failureContext);
        emitToolProgress(options, {
          type: 'coding.plan.updated',
          summary: `Replanned after ${failureContext.step} failure; plan now has ${plan.length} item(s).`,
          plan,
        });
        return JSON.stringify({ plan }, null, 2);
      },
    }),
  ];
}

interface ReplanToolArgs {
  taskId: string;
  currentStep: CodingWorkerLoopStep;
  turn: number;
  maxTurns: number;
  replanCount: number;
  plan: CodingPlanItem[];
  failureStep: CodingWorkerLoopStep;
  failureSummary: string;
  reviewFindings?: CodingCodeReviewFinding[];
  verificationEvidence?: CodingVerificationEvidence[];
}

function emitToolProgress(
  options: CodingPlanningToolsOptions,
  event: {
    type: CodingWorkerEventType;
    summary: string;
    plan?: CodingPlanItem[];
  },
): void {
  if (!options.reporter || !options.taskId) {
    return;
  }

  options.reporter.emit({
    type: event.type,
    taskId: options.taskId,
    summary: event.summary,
    plan: event.plan,
  });
}

function buildLoopStateFromToolArgs(args: ReplanToolArgs): CodingWorkerLoopState {
  return {
    task: {
      taskId: args.taskId,
      text: '',
    },
    sessionPlan: {
      taskId: args.taskId,
      leadSessionName: 'planning-tool',
      childSessions: {
        triage: 'planning-tool:triage',
        implementer: 'planning-tool:implementer',
        'test-debug': 'planning-tool:test-debug',
        'code-review': 'planning-tool:code-review',
        github: 'planning-tool:github',
      },
    },
    preflight: {
      repoPath: '',
      packageManager: 'unknown',
      scripts: {},
      verificationPlan: [],
    },
    currentStep: args.currentStep,
    turn: args.turn,
    maxTurns: args.maxTurns,
    plan: args.plan,
    approvalQueue: [],
    pendingEdits: {
      fileEdits: [],
      writeFiles: [],
    },
    verificationResults: {
      requiredCommands: [],
      evidence: [],
    },
    subagentHistory: [],
    replanCount: args.replanCount,
  };
}
