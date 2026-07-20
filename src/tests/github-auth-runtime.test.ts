import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  getGithubAuthService,
  resetGithubAuthRuntimeForTest,
} from '../engine/workers/coding-worker/github/github-auth-runtime.js';

test('GitHub auth runtime evicts a rejected service promise so the same key can recover', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'github-auth-workspace-'));
  const parent = mkdtempSync(join(tmpdir(), 'github-auth-runtime-'));
  const authRoot = join(parent, 'managed-auth');
  writeFileSync(authRoot, 'blocks directory creation');
  resetGithubAuthRuntimeForTest();

  try {
    await assert.rejects(getGithubAuthService({ workspaceRoot, authRoot }));

    unlinkSync(authRoot);
    const recovered = await getGithubAuthService({ workspaceRoot, authRoot });
    const cached = await getGithubAuthService({ workspaceRoot, authRoot });
    assert.equal(cached, recovered);
  } finally {
    resetGithubAuthRuntimeForTest();
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});
