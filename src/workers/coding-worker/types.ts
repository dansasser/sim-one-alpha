import type { NormalizedMessageEvent } from '../../types/index.js';

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

/**
 * Exact text edit applied by the coding worker.
 *
 * When `expectedOccurrences` is omitted, every occurrence of `oldText` is
 * replaced. Set `expectedOccurrences` when callers need a strict occurrence
 * count guard before replacement.
 */
export interface CodingFileEdit {
  path: string;
  oldText: string;
  newText: string;
  /**
   * Optional strict count guard for `oldText` before applying the edit.
   */
  expectedOccurrences?: number;
}

export interface CodingFileWrite {
  path: string;
  content: string;
}

export interface CodingVerificationCommandRequest {
  name: string;
  command: string;
  required?: boolean;
  reason?: string;
  cwd?: string;
  timeoutSeconds?: number;
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

export interface CodingSubagentRunResult {
  subagent: CodingSubagentKind;
  summary: string;
  evidence: string[];
  nextAction?: string;
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
}
