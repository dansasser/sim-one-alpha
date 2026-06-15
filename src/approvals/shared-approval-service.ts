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
 * 2. Sibling path next to the coding-worker workspace root: `<workspaceRoot>/../.gorombo-approvals`
 *
 * Throws if neither a configured root nor a workspace root is available.
 */
export function resolveCodingApprovalRoot(
  env: SharedCodingApprovalServiceEnv,
  workspaceRoot?: string,
): string {
  const configuredRoot = env.GOROMBO_APPROVAL_ROOT;
  if (typeof configuredRoot === 'string' && configuredRoot.length > 0) {
    return resolvePath(configuredRoot);
  }
  if (workspaceRoot) {
    return resolvePath(workspaceRoot, '..', '.gorombo-approvals');
  }
  throw new Error(
    'Missing approval storage root. Set GOROMBO_APPROVAL_ROOT or provide a workspace root for the fallback sibling path.',
  );
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
