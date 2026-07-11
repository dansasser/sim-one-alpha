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
  const unauthenticatedHome = mkdtempSync(join(tmpdir(), 'github-auth-live-no-credentials-'));
  try {
    const parsedRepository = new URL(repository!);
    assert.equal(parsedRepository.protocol, 'https:');
    assert.equal(parsedRepository.hostname, 'github.com');
    assert.ok(parsedRepository.port === '' || parsedRepository.port === '443');
    assert.equal(parsedRepository.username, '');
    assert.equal(parsedRepository.password, '');
    const repositoryName = parsedRepository.pathname.replace(/^\//, '').replace(/\.git$/, '');
    assert.match(repositoryName, /^[^/]+\/[^/]+$/);

    await assert.rejects(execFileAsync('git', ['ls-remote', '--exit-code', repository!, 'HEAD'], {
      env: {
        PATH: process.env.PATH,
        HOME: unauthenticatedHome,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
      timeout: 60_000,
      windowsHide: true,
    }));

    const service = await createGithubAuthService({ workspaceRoot, authRoot });
    const status = await service.status();
    assert.equal(status.state, 'authenticated');
    assert.ok(status.accountLogin);

    const ghEnv = await service.createGhEnv();
    const privateResult = await execFileAsync(
      'gh',
      ['repo', 'view', repositoryName, '--json', 'isPrivate', '--jq', '.isPrivate'],
      { env: ghEnv, timeout: 60_000, windowsHide: true },
    );
    assert.equal(privateResult.stdout.trim(), 'true');

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
    rmSync(unauthenticatedHome, { recursive: true, force: true });
  }
});
