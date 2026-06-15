import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { describe, it } from 'node:test';
import {
  createSharedCodingApprovalService,
  resolveCodingApprovalRoot,
} from '../approvals/shared-approval-service.js';

describe('shared approval service', () => {
  function makeTempDir(prefix: string): string {
    return mkdtempSync(join(tmpdir(), prefix));
  }

  function cleanup(dir: string): void {
    rmSync(dir, { recursive: true, force: true });
  }

  it('resolves GOROMBO_APPROVAL_ROOT from env', () => {
    const root = makeTempDir('gorombo-approval-root-');
    try {
      const resolved = resolveCodingApprovalRoot({ GOROMBO_APPROVAL_ROOT: root });
      assert.equal(resolved, resolvePath(root));
    } finally {
      cleanup(root);
    }
  });

  it('falls back to a sibling of the workspace root when env is not set', () => {
    const workspaceRoot = makeTempDir('gorombo-workspace-');
    try {
      const resolved = resolveCodingApprovalRoot({}, workspaceRoot);
      assert.equal(resolved, resolvePath(workspaceRoot, '..', '.gorombo-approvals'));
    } finally {
      cleanup(workspaceRoot);
    }
  });

  it('prefers the env root over the workspace fallback', () => {
    const envRoot = makeTempDir('gorombo-approval-root-');
    const workspaceRoot = makeTempDir('gorombo-workspace-');
    try {
      const resolved = resolveCodingApprovalRoot({ GOROMBO_APPROVAL_ROOT: envRoot }, workspaceRoot);
      assert.equal(resolved, resolvePath(envRoot));
    } finally {
      cleanup(envRoot);
      cleanup(workspaceRoot);
    }
  });

  it('throws when neither env nor workspace root is provided', () => {
    assert.throws(
      () => resolveCodingApprovalRoot({}),
      /Missing approval storage root/,
    );
  });

  it('two callers with the same root see the same pending record', async () => {
    const approvalRoot = makeTempDir('gorombo-approval-root-');
    try {
      const workerService = createSharedCodingApprovalService({ GOROMBO_APPROVAL_ROOT: approvalRoot });
      const ingressService = createSharedCodingApprovalService({ GOROMBO_APPROVAL_ROOT: approvalRoot });

      const request = await workerService.createRequest({
        taskId: 'task-shared-root',
        actionType: 'file.edit',
        summary: 'Shared root test',
        reason: 'Testing shared approval root.',
        target: 'file.txt',
        risk: 'low',
      });

      const pendingFromIngress = await ingressService.listRecords();
      assert.equal(pendingFromIngress.length, 1);
      assert.equal(pendingFromIngress[0].request.id, request.id);
      assert.equal(pendingFromIngress[0].status, 'pending');
    } finally {
      cleanup(approvalRoot);
    }
  });
});
