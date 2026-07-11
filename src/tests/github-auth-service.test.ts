import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createGithubAuthService,
  type GithubAuthCommandResult,
  type GithubAuthCommandRunner,
  type GithubAuthLoginRunner,
} from '../engine/workers/coding-worker/github/github-auth-service.js';

const initiatingAudience = {
  connector: 'web-api',
  actorId: 'actor-1',
  conversationId: 'conversation-1',
  eventId: 'event-1',
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  assert.fail(message);
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

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

    const cancelledResult = await service.cancel({
      authSessionId: result.authSessionId!,
      audience: initiatingAudience,
    } as Parameters<typeof service.cancel>[0]);
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
    assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(env.GIT_CONFIG_COUNT, '3');
    assert.equal(env.GIT_CONFIG_KEY_0, 'credential.helper');
    assert.equal(env.GIT_CONFIG_VALUE_0, '');
    assert.equal(env.GIT_CONFIG_KEY_1, 'credential.https://github.com.helper');
    assert.equal(env.GIT_CONFIG_VALUE_1, '');
    assert.equal(env.GIT_CONFIG_KEY_2, 'credential.https://github.com.helper');
    assert.equal(env.GIT_CONFIG_VALUE_2, '!gh auth git-credential');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(authRoot, { recursive: true, force: true });
  }
});

test('completed browser login bypasses the active-session cache and runs all verification checks', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'github-auth-workspace-'));
  const authRoot = mkdtempSync(join(tmpdir(), 'github-auth-root-'));
  const completion = deferred<GithubAuthCommandResult>();
  const calls: string[][] = [];
  const runner: GithubAuthCommandRunner = async (args) => {
    calls.push(args);
    if (args[0] === 'auth') return { exitCode: 0, stdout: 'Logged in', stderr: '' };
    if (args[0] === 'api') return { exitCode: 0, stdout: 'octocat\n', stderr: '' };
    return { exitCode: 0, stdout: 'https\n', stderr: '' };
  };
  const loginRunner: GithubAuthLoginRunner = {
    start: async (_args, _env, onOutput) => {
      onOutput('Copy your one-time code: WXYZ-1234\nOpen https://github.com/login/device.');
      return {
        completion: completion.promise,
        cancel: () => undefined,
      };
    },
  };

  try {
    const service = await createGithubAuthService({ workspaceRoot, authRoot, runner, loginRunner });
    const started = await service.start({
      audience: initiatingAudience,
      deliverChallenge: () => undefined,
    });
    assert.equal(started.state, 'authorization_pending');

    completion.resolve({ exitCode: 0, stdout: '', stderr: '' });
    await waitFor(
      () => calls.length === 3,
      'successful device login did not execute status, identity, and HTTPS verification',
    );

    assert.deepEqual(calls, [
      ['auth', 'status', '--active', '--hostname', 'github.com'],
      ['api', 'user', '--jq', '.login'],
      ['config', 'get', 'git_protocol', '--host', 'github.com'],
    ]);
    const result = await service.status();
    assert.equal(result.state, 'authenticated');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(authRoot, { recursive: true, force: true });
  }
});

test('an active GitHub auth profile cannot be reused by a different audience', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'github-auth-workspace-'));
  const authRoot = mkdtempSync(join(tmpdir(), 'github-auth-root-'));
  let loginStarts = 0;
  let secondDeliveries = 0;
  const loginRunner: GithubAuthLoginRunner = {
    start: async (_args, _env, onOutput) => {
      loginStarts += 1;
      onOutput('Copy your one-time code: WXYZ-1234\nOpen https://github.com/login/device.');
      return {
        completion: new Promise(() => undefined),
        cancel: () => undefined,
      };
    },
  };

  try {
    const service = await createGithubAuthService({ workspaceRoot, authRoot, loginRunner });
    await service.start({ audience: initiatingAudience, deliverChallenge: () => undefined });

    await assert.rejects(
      service.start({
        audience: { ...initiatingAudience, actorId: 'actor-2' },
        deliverChallenge: () => {
          secondDeliveries += 1;
        },
      }),
      /audience|another/i,
    );
    assert.equal(loginStarts, 1);
    assert.equal(secondDeliveries, 0);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(authRoot, { recursive: true, force: true });
  }
});

test('GitHub auth cancellation is bound to the initiating audience', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'github-auth-workspace-'));
  const authRoot = mkdtempSync(join(tmpdir(), 'github-auth-root-'));
  let cancelled = false;
  const loginRunner: GithubAuthLoginRunner = {
    start: async (_args, _env, onOutput) => {
      onOutput('Copy your one-time code: WXYZ-1234\nOpen https://github.com/login/device.');
      return {
        completion: new Promise(() => undefined),
        cancel: () => {
          cancelled = true;
        },
      };
    },
  };

  try {
    const service = await createGithubAuthService({ workspaceRoot, authRoot, loginRunner });
    const started = await service.start({ audience: initiatingAudience, deliverChallenge: () => undefined });
    const mismatchedCancellation = {
      authSessionId: started.authSessionId!,
      audience: { ...initiatingAudience, conversationId: 'conversation-2' },
    } as Parameters<typeof service.cancel>[0];

    await assert.rejects(service.cancel(mismatchedCancellation), /audience|session/i);
    assert.equal(cancelled, false);

    const matchingCancellation = {
      authSessionId: started.authSessionId!,
      audience: initiatingAudience,
    } as Parameters<typeof service.cancel>[0];
    const result = await service.cancel(matchingCancellation);
    assert.equal(result.state, 'cancelled');
    assert.equal(cancelled, true);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(authRoot, { recursive: true, force: true });
  }
});

test('GitHub auth rejects audiences with missing or malformed required fields before login starts', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'github-auth-workspace-'));
  const authRoot = mkdtempSync(join(tmpdir(), 'github-auth-root-'));
  let loginStarts = 0;
  const loginRunner: GithubAuthLoginRunner = {
    start: async (_args, _env, onOutput) => {
      loginStarts += 1;
      onOutput('Copy your one-time code: WXYZ-1234\nOpen https://github.com/login/device.');
      return {
        completion: new Promise(() => undefined),
        cancel: () => undefined,
      };
    },
  };
  const invalidAudiences: unknown[] = [];
  for (const key of ['connector', 'actorId', 'conversationId', 'eventId'] as const) {
    const missing = { ...initiatingAudience } as Record<string, unknown>;
    delete missing[key];
    invalidAudiences.push(missing, { ...initiatingAudience, [key]: '' }, { ...initiatingAudience, [key]: '   ' }, {
      ...initiatingAudience,
      [key]: 42,
    });
  }

  try {
    const service = await createGithubAuthService({ workspaceRoot, authRoot, loginRunner });
    for (const audience of invalidAudiences) {
      await assert.rejects(
        service.start({
          audience: audience as typeof initiatingAudience,
          deliverChallenge: () => undefined,
        }),
        /GitHub auth audience requires/i,
      );
    }
    assert.equal(loginStarts, 0);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(authRoot, { recursive: true, force: true });
  }
});

test('GitHub auth status distinguishes infrastructure failures from an explicit logged-out result', async () => {
  const cases: Array<{ name: string; result: GithubAuthCommandResult }> = [
    {
      name: 'missing gh executable',
      result: {
        exitCode: 1,
        stdout: '',
        stderr: 'spawn gh ENOENT',
        failureKind: 'not_found',
      } as GithubAuthCommandResult,
    },
    {
      name: 'command timeout',
      result: {
        exitCode: 1,
        stdout: '',
        stderr: 'gh auth status timed out',
        failureKind: 'timeout',
      } as GithubAuthCommandResult,
    },
    {
      name: 'malformed configuration',
      result: {
        exitCode: 1,
        stdout: '',
        stderr: 'failed to parse hosts.yml',
        failureKind: 'execution',
      } as GithubAuthCommandResult,
    },
    {
      name: 'network or other execution failure',
      result: {
        exitCode: 1,
        stdout: '',
        stderr: 'network unavailable',
        failureKind: 'execution',
      } as GithubAuthCommandResult,
    },
  ];

  for (const testCase of cases) {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'github-auth-workspace-'));
    const authRoot = mkdtempSync(join(tmpdir(), 'github-auth-root-'));
    try {
      const service = await createGithubAuthService({
        workspaceRoot,
        authRoot,
        runner: async () => testCase.result,
      });
      const result = await service.status();
      assert.ok(
        result.state === 'unknown' || result.state === 'failed',
        `${testCase.name} was incorrectly classified as ${result.state}`,
      );
      assert.ok(result.failureCode, `${testCase.name} did not return a failure code`);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(authRoot, { recursive: true, force: true });
    }
  }
});

test('managed GitHub auth directories are chmodded to 0700 even when they already exist', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'github-auth-workspace-'));
  const authRoot = mkdtempSync(join(tmpdir(), 'github-auth-root-'));
  const profilesRoot = join(authRoot, 'profiles');
  const profileRoot = join(profilesRoot, 'default');
  const ghConfigDir = join(profileRoot, 'gh');
  mkdirSync(ghConfigDir, { recursive: true });
  for (const path of [authRoot, profilesRoot, profileRoot, ghConfigDir]) {
    chmodSync(path, 0o755);
  }

  try {
    const service = await createGithubAuthService({ workspaceRoot, authRoot });
    await service.createGhEnv();

    for (const path of [authRoot, profilesRoot, profileRoot, ghConfigDir]) {
      assert.equal(mode(path), 0o700, `${path} did not have managed-directory permissions`);
    }
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(authRoot, { recursive: true, force: true });
  }
});

test('GitHub auth rejects a missing auth root whose existing parent symlinks into the workspace', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'github-auth-workspace-'));
  const outsideRoot = mkdtempSync(join(tmpdir(), 'github-auth-symlink-parent-'));
  const linkedParent = join(outsideRoot, 'linked-parent');
  const authRoot = join(linkedParent, 'managed-auth');
  symlinkSync(workspaceRoot, linkedParent, 'dir');

  try {
    await assert.rejects(
      createGithubAuthService({ workspaceRoot, authRoot }),
      /outside the coding-worker workspace root/i,
    );
    assert.equal(existsSync(join(workspaceRoot, 'managed-auth')), false);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test('GitHub auth expiry cancels and evicts an abandoned authorization process', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'github-auth-workspace-'));
  const authRoot = mkdtempSync(join(tmpdir(), 'github-auth-root-'));
  let cancelled = false;
  const loginRunner: GithubAuthLoginRunner = {
    start: async (_args, _env, onOutput) => {
      onOutput('Copy your one-time code: WXYZ-1234\nOpen https://github.com/login/device.');
      return {
        completion: new Promise(() => undefined),
        cancel: () => {
          cancelled = true;
        },
      };
    },
  };

  try {
    const service = await createGithubAuthService({
      workspaceRoot,
      authRoot,
      loginRunner,
      sessionTtlMs: 20,
    } as Parameters<typeof createGithubAuthService>[0]);
    const started = await service.start({ audience: initiatingAudience, deliverChallenge: () => undefined });

    await waitFor(() => cancelled, 'expired GitHub authorization process was not cancelled');
    await assert.rejects(
      service.cancel({
        authSessionId: started.authSessionId!,
        audience: initiatingAudience,
      } as Parameters<typeof service.cancel>[0]),
      /not found/i,
    );
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(authRoot, { recursive: true, force: true });
  }
});

test('start does not reuse an active session after its advertised expiry', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'github-auth-workspace-'));
  const authRoot = mkdtempSync(join(tmpdir(), 'github-auth-root-'));
  const originalNow = Date.now;
  let now = originalNow();
  let loginStarts = 0;
  let cancellations = 0;
  const loginRunner: GithubAuthLoginRunner = {
    start: async (_args, _env, onOutput) => {
      loginStarts += 1;
      onOutput(`Copy your one-time code: WXYZ-${String(1233 + loginStarts).padStart(4, '0')}\nOpen https://github.com/login/device.`);
      return {
        completion: new Promise(() => undefined),
        cancel: () => {
          cancellations += 1;
        },
      };
    },
  };

  try {
    Date.now = () => now;
    const service = await createGithubAuthService({ workspaceRoot, authRoot, loginRunner });
    const first = await service.start({ audience: initiatingAudience, deliverChallenge: () => undefined });
    now += 16 * 60_000;
    const second = await service.start({ audience: initiatingAudience, deliverChallenge: () => undefined });

    assert.notEqual(second.authSessionId, first.authSessionId);
    assert.equal(loginStarts, 2);
    assert.equal(cancellations, 1);
  } finally {
    Date.now = originalNow;
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(authRoot, { recursive: true, force: true });
  }
});

test('terminal GitHub auth sessions release their process and are evicted', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'github-auth-workspace-'));
  const authRoot = mkdtempSync(join(tmpdir(), 'github-auth-root-'));
  const completion = deferred<GithubAuthCommandResult>();
  const loginRunner: GithubAuthLoginRunner = {
    start: async (_args, _env, onOutput) => {
      onOutput('Copy your one-time code: WXYZ-1234\nOpen https://github.com/login/device.');
      return {
        completion: completion.promise,
        cancel: () => undefined,
      };
    },
  };

  try {
    const service = await createGithubAuthService({ workspaceRoot, authRoot, loginRunner });
    const started = await service.start({ audience: initiatingAudience, deliverChallenge: () => undefined });
    completion.resolve({ exitCode: 1, stdout: '', stderr: 'authorization denied' });
    await completion.promise;

    await assert.rejects(
      service.cancel({
        authSessionId: started.authSessionId!,
        audience: initiatingAudience,
      } as Parameters<typeof service.cancel>[0]),
      /not found/i,
    );
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(authRoot, { recursive: true, force: true });
  }
});
