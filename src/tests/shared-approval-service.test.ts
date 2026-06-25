import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { describe, it } from 'node:test';
import {
  createSharedCodingApprovalService,
  resolveCodingApprovalRoot,
} from '../engine/approvals/shared-approval-service.js';

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

  it('falls back to ~/.gorombo/approvals when env is not set', () => {
    const resolved = resolveCodingApprovalRoot({});
    assert.equal(resolved, resolvePath(homedir(), '.gorombo', 'approvals'));
  });

  it('prefers the env root over the default fallback', () => {
    const envRoot = makeTempDir('gorombo-approval-root-');
    try {
      const resolved = resolveCodingApprovalRoot({ GOROMBO_APPROVAL_ROOT: envRoot });
      assert.equal(resolved, resolvePath(envRoot));
    } finally {
      cleanup(envRoot);
    }
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
