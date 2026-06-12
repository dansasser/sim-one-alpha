import type { NormalizedMessageEvent } from '../../types/index.js';

export type CodingSubagentKind =
  | 'triage'
  | 'implementer'
  | 'test-debug'
  | 'code-review'
  | 'github';

export type CodingWorkerRunStatus = 'completed' | 'failed' | 'blocked' | 'needs_approval';

export type VerificationStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

export interface CodingWorkerTaskRequest {
  taskId: string;
  text: string;
  event?: NormalizedMessageEvent;
  repoPath?: string;
  sessionId?: string;
  github?: CodingGithubContextRequest;
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

