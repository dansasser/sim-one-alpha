import type { CodingWorkerRunResult } from '../../../../engine/workers/coding-worker/types.js';

export function assertCodingWorkerCanComplete(result: CodingWorkerRunResult): void {
  if (result.status !== 'completed') {
    return;
  }

  const required = result.verification.requiredCommands.filter((command) => command.required);
  const missing = required.filter((command) => command.status !== 'passed');
  if (required.length === 0 || missing.length > 0) {
    throw new Error('Coding worker cannot report completed without passing required verification evidence.');
  }
}

