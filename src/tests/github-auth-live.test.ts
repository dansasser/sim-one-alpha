import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { createGithubAuthService } from '../engine/workers/coding-worker/github/github-auth-service.js';

const execFileAsync = promisify(execFile);
const repository = process.env.GOROMBO_GITHUB_LIVE_TEST_REPOSITORY;
const authRoot = process.env.GOROMBO_GITHUB_AUTH_ROOT;

test('live managed GitHub profile can inspect an explicitly approved disposable private repository', {
  skip: !repository || !authRoot,
}, async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'github-auth-live-workspace-'));
  const cloneRoot = mkdtempSync(join(tmpdir(), 'github-auth-live-clone-'));
  try {
    const service = await createGithubAuthService({ workspaceRoot, authRoot });
    const status = await service.status();
    assert.equal(status.state, 'authenticated');
    assert.ok(status.accountLogin);

    const env = await service.createGitCredentialEnv();
    const remote = await execFileAsync('git', ['ls-remote', '--exit-code', repository!, 'HEAD'], {
      env,
      timeout: 60_000,
      windowsHide: true,
    });
    assert.match(remote.stdout, /\S/);

    const clonePath = join(cloneRoot, 'repository');
    await execFileAsync('git', ['clone', '--', repository!, clonePath], {
      env,
      timeout: 120_000,
      windowsHide: true,
    });
    const origin = await execFileAsync('git', ['-C', clonePath, 'remote', 'get-url', 'origin'], {
      env,
      timeout: 30_000,
      windowsHide: true,
    });
    assert.equal(origin.stdout.trim(), repository);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(cloneRoot, { recursive: true, force: true });
  }
});
