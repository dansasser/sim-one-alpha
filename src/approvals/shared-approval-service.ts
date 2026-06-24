import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { createFileCodingApprovalService, type CodingApprovalService } from '../workers/coding-worker/approvals/approval-service.js';

export interface SharedCodingApprovalServiceEnv {
  GOROMBO_APPROVAL_ROOT?: string | undefined;
  [key: string]: unknown;
}

/**
 * Resolves the on-disk root used for approval persistence.
 *
 * Order of resolution:
 * 1. `env.GOROMBO_APPROVAL_ROOT`
 * 2. `~/.gorombo/approvals` (unified runtime data root)
 *
 * Throws if GOROMBO_APPROVAL_ROOT is not set and the home directory
 * cannot be resolved.
 */
export function resolveCodingApprovalRoot(
  env: SharedCodingApprovalServiceEnv,
  _workspaceRoot?: string,
): string {
  const configuredRoot = env.GOROMBO_APPROVAL_ROOT;
  if (typeof configuredRoot === 'string' && configuredRoot.length > 0) {
    return resolvePath(configuredRoot);
  }
  return resolvePath(homedir(), '.gorombo', 'approvals');
}

/**
 * Creates a single `CodingApprovalService` instance backed by the shared approval root.
 *
 * The coding worker and the HTTP/CLI/Telegram ingress layer must use the same root
 * so that approval requests created by the worker are visible to the ingress and
 * decisions recorded by the ingress are visible to the worker.
 */
export function createSharedCodingApprovalService(
  env: SharedCodingApprovalServiceEnv,
  workspaceRoot?: string,
): CodingApprovalService {
  const approvalRoot = resolveCodingApprovalRoot(env, workspaceRoot);
  return createFileCodingApprovalService(approvalRoot);
}
