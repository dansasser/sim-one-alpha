import { defineTool, type ToolDefinition } from '@flue/runtime';
import * as v from 'valibot';
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

const CodingWorkerLoopStepSchema = v.union([
  v.literal('triage'),
  v.literal('implement'),
  v.literal('test-debug'),
  v.literal('code-review'),
  v.literal('github'),
  v.literal('commit'),
  v.literal('push'),
  v.literal('pr'),
  v.literal('replanned'),
  v.literal('completed'),
  v.literal('blocked'),
  v.literal('error'),
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
      parameters: v.object({
        taskId: v.string(),
        text: v.string(),
        filesToInspect: v.optional(v.array(v.string())),
        hasGithubContext: v.optional(v.boolean()),
        packageManager: v.optional(v.string()),
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
      parameters: v.object({
        taskId: v.string(),
        currentStep: CodingWorkerLoopStepSchema,
        turn: v.number(),
        maxTurns: v.number(),
        replanCount: v.number(),
        plan: v.array(
          v.object({
            id: v.string(),
            description: v.string(),
            owner: v.union([
              v.literal('triage'),
              v.literal('implementer'),
              v.literal('test-debug'),
              v.literal('code-review'),
              v.literal('github'),
              v.literal('coding-worker'),
            ]),
            status: v.union([
              v.literal('pending'),
              v.literal('in_progress'),
              v.literal('completed'),
              v.literal('blocked'),
            ]),
          })
        ),
        failureStep: CodingWorkerLoopStepSchema,
        failureSummary: v.string(),
        reviewFindings: v.optional(
          v.array(
            v.object({
              file: v.optional(v.string()),
              lineStart: v.optional(v.number()),
              lineEnd: v.optional(v.number()),
              severity: v.union([v.literal('info'), v.literal('warning'), v.literal('blocker')]),
              message: v.string(),
            })
          )
        ),
        verificationEvidence: v.optional(
          v.array(
            v.object({
              command: v.string(),
              status: v.union([v.literal('passed'), v.literal('failed'), v.literal('skipped')]),
              exitCode: v.optional(v.number()),
              summary: v.string(),
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
