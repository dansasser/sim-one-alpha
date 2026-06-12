import type { CodingWorkerRunResult } from '../types.js';
import type { CodingWorkerEvent } from './coding-worker-events.js';

export interface OrchestratorCodingProgressUpdate {
  taskId: string;
  latestSummary: string;
  events: CodingWorkerEvent[];
}

export function createOrchestratorProgressUpdate(
  taskId: string,
  events: CodingWorkerEvent[],
): OrchestratorCodingProgressUpdate {
  const latest = [...events].reverse().find((event) => event.summary || event.nextAction || event.decision);

  return {
    taskId,
    latestSummary: latest?.summary ?? latest?.nextAction ?? latest?.decision ?? 'Coding worker progress updated.',
    events,
  };
}

export function createOrchestratorResultSummary(result: CodingWorkerRunResult): string {
  const verification = result.verification.evidence.map((item) => `${item.command}: ${item.status}`).join(', ');
  const verificationSummary = verification ? ` Verification: ${verification}.` : ' Verification evidence is missing.';

  return `${result.status}: ${result.summary}.${verificationSummary}`;
}

