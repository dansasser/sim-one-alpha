import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createGithubAuthService,
  type GithubAuthCommandRunner,
  type GithubAuthLoginRunner,
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

test('GitHub auth start relays a device challenge privately and returns only opaque session state', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'github-auth-workspace-'));
  const authRoot = mkdtempSync(join(tmpdir(), 'github-auth-root-'));
  const challenges: unknown[] = [];
  let cancelled = false;
  const submittedInput: string[] = [];
  const runner: GithubAuthCommandRunner = async () => ({ exitCode: 1, stdout: '', stderr: 'not logged in' });
  const loginRunner: GithubAuthLoginRunner = {
    start: async (args, env, onOutput) => {
      assert.deepEqual(args, [
        'auth',
        'login',
        '--hostname',
        'github.com',
        '--git-protocol',
        'https',
        '--web',
        '--skip-ssh-key',
        '--scopes',
        'workflow',
      ]);
      assert.equal(env.GH_CONFIG_DIR, join(authRoot, 'profiles', 'default', 'gh'));
      onOutput('First copy your one-time code: WXYZ-1234\nPress Enter to open https://github.com/login/device in your browser.');
      return {
        completion: new Promise(() => undefined),
        cancel: () => {
          cancelled = true;
        },
        submitInput: (value) => {
          submittedInput.push(value);
        },
      };
    },
  };

  try {
    const service = await createGithubAuthService({ workspaceRoot, authRoot, runner, loginRunner });

    const result = await service.start({
      audience: { connector: 'web-api', actorId: 'actor-1', conversationId: 'conversation-1', eventId: 'event-1' },
      deliverChallenge: (challenge) => {
        challenges.push(challenge);
      },
    });

    assert.equal(result.state, 'authorization_pending');
    assert.equal(result.profile, 'default');
    assert.ok(result.authSessionId);
    assert.equal('userCode' in result, false);
    assert.equal('verificationUri' in result, false);
    assert.deepEqual(challenges, [{
      sessionId: result.authSessionId,
      audience: { connector: 'web-api', actorId: 'actor-1', conversationId: 'conversation-1', eventId: 'event-1' },
      verificationUri: 'https://github.com/login/device',
      userCode: 'WXYZ-1234',
      expiresAt: result.expiresAt,
    }]);
    assert.deepEqual(submittedInput, ['\n']);

    const cancelledResult = await service.cancel({ authSessionId: result.authSessionId! });
    assert.equal(cancelledResult.state, 'cancelled');
    assert.equal(cancelled, true);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(authRoot, { recursive: true, force: true });
  }
});

test('GitHub auth reports authenticated only after managed CLI status, API identity, and HTTPS protocol checks succeed', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'github-auth-workspace-'));
  const authRoot = mkdtempSync(join(tmpdir(), 'github-auth-root-'));
  const calls: string[][] = [];
  const runner: GithubAuthCommandRunner = async (args) => {
    calls.push(args);
    if (args[0] === 'auth') return { exitCode: 0, stdout: 'Logged in', stderr: '' };
    if (args[0] === 'api') return { exitCode: 0, stdout: 'octocat\n', stderr: '' };
    return { exitCode: 0, stdout: 'https\n', stderr: '' };
  };

  try {
    const service = await createGithubAuthService({ workspaceRoot, authRoot, runner });

    const result = await service.status();

    assert.equal(result.state, 'authenticated');
    assert.equal(result.credentialSource, 'managed_profile');
    assert.equal(result.accountLogin, 'octocat');
    assert.equal(result.gitProtocol, 'https');
    assert.deepEqual(calls, [
      ['auth', 'status', '--active', '--hostname', 'github.com'],
      ['api', 'user', '--jq', '.login'],
      ['config', 'get', 'git_protocol', '--host', 'github.com'],
    ]);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(authRoot, { recursive: true, force: true });
  }
});

test('an invalid explicitly configured GitHub token does not fall back to a managed profile', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'github-auth-workspace-'));
  const authRoot = mkdtempSync(join(tmpdir(), 'github-auth-root-'));
  const runner: GithubAuthCommandRunner = async (_args, env) => {
    assert.equal(env.GH_TOKEN, 'invalid-explicit-token');
    return { exitCode: 1, stdout: '', stderr: 'bad credentials' };
  };

  try {
    const service = await createGithubAuthService({
      workspaceRoot,
      authRoot,
      env: { GH_TOKEN: 'invalid-explicit-token' },
      runner,
    });

    const result = await service.status();

    assert.equal(result.state, 'invalid');
    assert.equal(result.credentialSource, 'gh_token');
    assert.equal(result.failureCode, 'github_auth_status_failed');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(authRoot, { recursive: true, force: true });
  }
});

test('GitHub git credential environment is managed, HTTPS-only, and not shell-wide', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'github-auth-workspace-'));
  const authRoot = mkdtempSync(join(tmpdir(), 'github-auth-root-'));
  try {
    const service = await createGithubAuthService({ workspaceRoot, authRoot });

    const env = await service.createGitCredentialEnv();

    assert.equal(env.GH_CONFIG_DIR, join(authRoot, 'profiles', 'default', 'gh'));
    assert.equal(env.HOME, undefined);
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.GIT_CONFIG_COUNT, '2');
    assert.equal(env.GIT_CONFIG_KEY_0, 'credential.https://github.com.helper');
    assert.equal(env.GIT_CONFIG_VALUE_0, '');
    assert.equal(env.GIT_CONFIG_KEY_1, 'credential.https://github.com.helper');
    assert.equal(env.GIT_CONFIG_VALUE_1, '!gh auth git-credential');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(authRoot, { recursive: true, force: true });
  }
});
