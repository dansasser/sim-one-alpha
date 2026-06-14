import { defineTool, Type, type ToolDefinition } from '@flue/runtime';
import type { CodingPlanItem, CodingWorkerLoopState } from '../types.js';
import { createInitialPlan, replan, type PlanningContext, type ReplanFailureContext } from '../workflow/planning.js';

export function createCodingPlanningTools(): ToolDefinition[] {
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
        return JSON.stringify({ plan }, null, 2);
      },
    }),
    defineTool({
      name: 'coding_plan_replan',
      description:
        'Replan the worker-local loop after a failure or when new context is discovered. Returns an updated CodingPlanItem[].',
      parameters: Type.Object({
        taskId: Type.String(),
        currentStep: Type.String(),
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
        failureStep: Type.String(),
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
        const state = buildLoopStateFromToolArgs(args);
        const failureContext: ReplanFailureContext = {
          step: args.failureStep as ReplanFailureContext['step'],
          summary: args.failureSummary,
          reviewFindings: args.reviewFindings,
          verificationEvidence: args.verificationEvidence,
        };
        const plan = replan(state, failureContext);
        return JSON.stringify({ plan }, null, 2);
      },
    }),
  ];
}

function buildLoopStateFromToolArgs(
  args: Record<string, unknown>,
): CodingWorkerLoopState {
  return {
    task: {
      taskId: String(args.taskId),
      text: '',
    },
    sessionPlan: {
      taskId: args.taskId as string,
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
    currentStep: args.currentStep as CodingWorkerLoopState['currentStep'],
    turn: Number(args.turn),
    maxTurns: Number(args.maxTurns),
    plan: (args.plan as CodingPlanItem[]) ?? [],
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
    replanCount: Number(args.replanCount),
  } as unknown as CodingWorkerLoopState;
}
