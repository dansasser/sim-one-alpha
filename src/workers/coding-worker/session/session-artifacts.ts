import type { CodingSubagentKind } from '../types.js';

export interface CodingSessionArtifact {
  taskId: string;
  subagent: CodingSubagentKind | 'coding-worker';
  title: string;
  summary: string;
  evidence: string[];
}

export function createCodingSessionArtifact(input: CodingSessionArtifact): CodingSessionArtifact {
  return {
    ...input,
    evidence: [...input.evidence],
  };
}

