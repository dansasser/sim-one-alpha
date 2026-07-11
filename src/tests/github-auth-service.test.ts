import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createGithubAuthService,
  type GithubAuthCommandRunner,
} from '../engine/workers/coding-worker/github/github-auth-service.js';

test('GitHub auth status uses an empty managed profile instead of ambient host credentials', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'github-auth-workspace-'));
  const authRoot = mkdtempSync(join(tmpdir(), 'github-auth-root-'));
  const commands: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const runner: GithubAuthCommandRunner = async (args, env) => {
    commands.push({ args, env });
    return { exitCode: 1, stdout: '', stderr: 'not logged in' };
  };

  try {
    const service = await createGithubAuthService({ workspaceRoot, authRoot, runner });

    const result = await service.status({ profile: 'default' });

    assert.deepEqual(result, {
      state: 'unauthenticated',
      profile: 'default',
      hostname: 'github.com',
      credentialSource: 'none',
      checkedAt: result.checkedAt,
    });
    assert.equal(commands.length, 1);
    assert.deepEqual(commands[0]?.args, ['auth', 'status', '--active', '--hostname', 'github.com']);
    assert.equal(commands[0]?.env.GH_CONFIG_DIR, join(authRoot, 'profiles', 'default', 'gh'));
    assert.equal(commands[0]?.env.GH_TOKEN, undefined);
    assert.equal(commands[0]?.env.GITHUB_TOKEN, undefined);
    assert.equal(commands[0]?.env.HOME, undefined);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(authRoot, { recursive: true, force: true });
  }
});
