import type { NormalizedMessageEvent } from '../../types/index.js';

import {
  CodingFileEditSchema,
  CodingFileWriteSchema,
  CodingVerificationCommandRequestSchema,
  CodingImplementerResultSchema,
  CodingPlanItemSchema,
  CodingTriageResultSchema,
  CodingTestDebugResultSchema,
  CodingCodeReviewFindingSchema,
  CodingCodeReviewResultSchema,
  CodingGithubResultSchema,
} from '../../schemas/coding-worker.js';

export { CodingImplementerResultSchema };
export type CodingFileEdit = import('../../schemas/coding-worker.js').CodingFileEdit;
export type CodingFileWrite = import('../../schemas/coding-worker.js').CodingFileWrite;
export type CodingVerificationCommandRequest = import('../../schemas/coding-worker.js').CodingVerificationCommandRequest;
export type CodingImplementerResult = import('../../schemas/coding-worker.js').CodingImplementerResult;
export type CodingPlanItem = import('../../schemas/coding-worker.js').CodingPlanItem;
export type CodingTriageResult = import('../../schemas/coding-worker.js').CodingTriageResult;
export type CodingTestDebugResult = import('../../schemas/coding-worker.js').CodingTestDebugResult;
export type CodingCodeReviewFinding = import('../../schemas/coding-worker.js').CodingCodeReviewFinding;
export type CodingCodeReviewResult = import('../../schemas/coding-worker.js').CodingCodeReviewResult;
export type CodingGithubResult = import('../../schemas/coding-worker.js').CodingGithubResult;

// Re-export schemas as type-only references so isolatedModules remains happy
export type {
  CodingFileEditSchema,
  CodingFileWriteSchema,
  CodingVerificationCommandRequestSchema,
  CodingPlanItemSchema,
  CodingTriageResultSchema,
  CodingTestDebugResultSchema,
  CodingCodeReviewFindingSchema,
  CodingCodeReviewResultSchema,
  CodingGithubResultSchema,
};
export type CodingSubagentKind =
  | 'triage'
  | 'implementer'
  | 'test-debug'
  | 'code-review'
  | 'github';

export type CodingWorkerRunStatus = 'completed' | 'failed' | 'blocked' | 'needs_approval';

export type VerificationStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

export type CodingWorkspaceTargetKind = 'workspace' | 'project' | 'repo';

export interface CodingWorkerTaskRequest {
  taskId: string;
  text: string;
  event?: NormalizedMessageEvent;
  workspaceRoot?: string;
  targetKind?: CodingWorkspaceTargetKind;
  projectId?: string;
  projectSlug?: string;
  projectRelativePath?: string;
  git?: CodingGitWorkspaceContext;
  /**
   * Legacy direct-repository scope. Prefer workspaceRoot plus project metadata.
   */
  repoPath?: string;
  sessionId?: string;
  github?: CodingGithubContextRequest;
  filesToInspect?: string[];
  fileEdits?: CodingFileEdit[];
  debugEdits?: CodingFileEdit[];
  writeFiles?: CodingFileWrite[];
  verificationCommands?: CodingVerificationCommandRequest[];
  /**
   * Maximum number of lead-loop turns before the worker returns blocked.
   * Defaults to 10.
   */
  maxTurns?: number;
}

export interface CodingGitWorkspaceContext {
  remote?: string;
  branch?: string;
  worktreePath?: string;
}

export interface CodingGithubContextRequest {
  owner?: string;
  repo?: string;
  issueNumber?: number;
  pullRequestNumber?: number;
  url?: string;
}

export interface CodingVerificationCommand {
  name: string;
  command: string;
  required: boolean;
  reason: string;
  status: VerificationStatus;
}

export interface CodingVerificationEvidence {
  command: string;
  status: Exclude<VerificationStatus, 'pending' | 'running'>;
  exitCode?: number;
  summary: string;
}

export type CodingSubagentStructuredOutput =
  | { type: 'triage'; result: CodingTriageResult }
  | { type: 'implementer'; result: CodingImplementerResult }
  | { type: 'test-debug'; result: CodingTestDebugResult }
  | { type: 'code-review'; result: CodingCodeReviewResult }
  | { type: 'github'; result: CodingGithubResult };

type CodingSubagentRunResultBase<K extends CodingSubagentKind, R> = {
  subagent: K;
  summary: string;
  evidence: string[];
  structuredOutput: { type: K; result: R };
  nextAction?: string;
};

export type CodingSubagentRunResult =
  | CodingSubagentRunResultBase<'triage', CodingTriageResult>
  | CodingSubagentRunResultBase<'implementer', CodingImplementerResult>
  | CodingSubagentRunResultBase<'test-debug', CodingTestDebugResult>
  | CodingSubagentRunResultBase<'code-review', CodingCodeReviewResult>
  | CodingSubagentRunResultBase<'github', CodingGithubResult>;

export type CodingWorkerLoopStep =
  | 'triage'
  | 'implement'
  | 'test-debug'
  | 'code-review'
  | 'github'
  | 'commit'
  | 'push'
  | 'pr'
  | 'replanned'
  | 'completed'
  | 'blocked'
  | 'error';

export interface CodingWorkerLoopState {
  task: CodingWorkerTaskRequest;
  sessionPlan: import('./session/child-session-names.js').CodingWorkerSessionPlan;
  preflight: import('./repo/preflight.js').CodingRepoPreflight;
  currentStep: CodingWorkerLoopStep;
  turn: number;
  maxTurns: number;
  plan: CodingPlanItem[];
  approvalQueue: Array<{
    requestId: string;
    actionType: string;
    summary: string;
    status: 'pending' | 'approved' | 'denied';
  }>;
  pendingEdits: {
    fileEdits: CodingFileEdit[];
    writeFiles: CodingFileWrite[];
  };
  verificationResults: {
    requiredCommands: CodingVerificationCommand[];
    evidence: CodingVerificationEvidence[];
  };
  subagentHistory: CodingSubagentRunResult[];
  replanCount: number;
  lastFailureSummary?: string;
}

export interface CodingWorkerLoopCheckpoint {
  taskId: string;
  status: CodingWorkerRunStatus;
  currentStep: CodingWorkerLoopStep;
  turn: number;
  maxTurns: number;
  plan: CodingPlanItem[];
  approvalQueue: CodingWorkerLoopState['approvalQueue'];
  pendingEdits: CodingWorkerLoopState['pendingEdits'];
  verificationResults: CodingWorkerLoopState['verificationResults'];
  subagentHistory: CodingSubagentRunResult[];
  replanCount: number;
  lastFailureSummary?: string;
}

export interface CodingWorkerRunResult {
  taskId: string;
  status: CodingWorkerRunStatus;
  summary: string;
  plan: CodingPlanItem[];
  subagentResults: CodingSubagentRunResult[];
  verification: {
    requiredCommands: CodingVerificationCommand[];
    evidence: CodingVerificationEvidence[];
  };
  publicEvents: unknown[];
  artifacts: Array<{
    name: string;
    uri: string;
  }>;
  checkpoint?: CodingWorkerLoopCheckpoint;
}
