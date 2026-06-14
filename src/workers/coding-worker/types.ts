import type { NormalizedMessageEvent } from '../../types/index.js';

import {
  CodingFileEditSchema,
  CodingFileWriteSchema,
  CodingVerificationCommandRequestSchema,
  CodingImplementerResultSchema,
} from '../../schemas/coding-worker.js';

export { CodingImplementerResultSchema };
export type CodingFileEdit = import('../../schemas/coding-worker.js').CodingFileEdit;
export type CodingFileWrite = import('../../schemas/coding-worker.js').CodingFileWrite;
export type CodingVerificationCommandRequest = import('../../schemas/coding-worker.js').CodingVerificationCommandRequest;
export type CodingImplementerResult = import('../../schemas/coding-worker.js').CodingImplementerResult;

// Re-export schemas as type-only references so isolatedModules remains happy
export type { CodingFileEditSchema, CodingFileWriteSchema, CodingVerificationCommandRequestSchema };
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

export interface CodingPlanItem {
  id: string;
  description: string;
  owner: CodingSubagentKind | 'coding-worker';
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
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

export interface CodingTriageResult {
  plan: CodingPlanItem[];
  filesToInspect: string[];
  recommendedExecutionPath: 'implementer' | 'github' | 'test-debug' | 'code-review' | 'manual';
}


export interface CodingTestDebugResult {
  debugEdits: CodingFileEdit[];
  verificationCommands: CodingVerificationCommandRequest[];
}

export interface CodingCodeReviewResult {
  findings: string[];
  approved: boolean;
}

export interface CodingGithubResult {
  actions: Array<{
    action: 'comment' | 'create_pr' | 'update_pr' | 'merge_pr' | 'close_pr';
    payload: Record<string, unknown>;
  }>;
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
  structuredOutput?: { type: K; result: R };
  nextAction?: string;
};

export type CodingSubagentRunResult =
  | CodingSubagentRunResultBase<'triage', CodingTriageResult>
  | CodingSubagentRunResultBase<'implementer', CodingImplementerResult>
  | CodingSubagentRunResultBase<'test-debug', CodingTestDebugResult>
  | CodingSubagentRunResultBase<'code-review', CodingCodeReviewResult>
  | CodingSubagentRunResultBase<'github', CodingGithubResult>;

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
}
