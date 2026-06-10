import { defineAgentProfile, type AgentProfile } from '@flue/runtime';
import {
  composeWorkspaceInstructions,
  resolveWorkspaceDirectory,
} from '../../workspace-loader.js';
import type { WorkerRunRequest, WorkerRunResult } from '../../types/index.js';

export const codingWorkerAgentName = 'coding-worker';

export const codingWorkerInstructions = [
  composeWorkspaceInstructions({
    workspaceDir: resolveWorkspaceDirectory('workers/coding-worker/workspace'),
    title: 'Coding Worker Workspace Instructions',
  }),
  createCodingWorkerRuntimeCapabilityBlock(),
].join('\n\n');

/**
 * Creates the reusable coding worker Flue subagent profile used by the orchestrator.
 */
export function createCodingWorkerSubagent(): AgentProfile {
  return defineAgentProfile({
    name: codingWorkerAgentName,
    description: 'placeholder coding worker for future plan, edit, test, debug loop, diff, and approval behavior.',
    model: false,
    instructions: codingWorkerInstructions,
  });
}

export async function runCodingWorkerPlaceholder(
  request: WorkerRunRequest,
): Promise<WorkerRunResult> {
  return {
    id: `coding-worker-result:${request.id}`,
    workerId: request.workerId,
    status: 'not_implemented',
    summary:
      'Coding worker runtime is intentionally placeholder-only in Phase 1. Future behavior will add plan, edit, test, debug loop, diff, and approval.',
    artifacts: [],
  };
}

/**
 * Describes the coding worker capabilities that are actually wired at runtime.
 */
function createCodingWorkerRuntimeCapabilityBlock(): string {
  return `# Runtime Capabilities

The coding worker is registered as a placeholder subagent only.

No coding tools, filesystem tools, repository tools, shell tools, or approval workflow are attached to this worker yet. If invoked, state that implementation is pending instead of claiming to plan, edit, test, debug, diff, or approve code changes.`;
}

