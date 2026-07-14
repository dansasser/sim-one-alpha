import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ToolDefinition } from '@flue/runtime';
import {
  createInMemoryCodingApprovalService,
  type CodingApprovalService,
} from '../engine/workers/coding-worker/approvals/approval-service.js';
import type { GitHubClient } from '../engine/workers/coding-worker/github/github-client.js';
import type { GithubAuthService } from '../engine/workers/coding-worker/github/github-auth-service.js';
import { InMemoryCodingRepoRegistry } from '../engine/workers/coding-worker/repo/repo-registry.js';
import { createCodingWorkerSubagent } from '../engine/workers/coding-worker/coding-worker.js';
import { createCodingGitTools } from '../engine/workers/coding-worker/tools/coding-git-tools.js';
import { createCodingRepoWorkflowTools } from '../engine/workers/coding-worker/tools/coding-repo-workflow-tools.js';
import type { CodingSandboxRuntime } from '../engine/workers/coding-worker/tools/sandbox-runtime.js';
import { githubUrlCredentialOptions } from '../engine/workers/coding-worker/tools/github-credential-utils.js';

const managedGithubEnv = {
  GH_CONFIG_DIR: '/managed/github/default/gh',
  GIT_CONFIG_COUNT: '3',
  GIT_CONFIG_KEY_0: 'credential.helper',
  GIT_CONFIG_VALUE_0: '',
  GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
  GIT_CONFIG_VALUE_1: '',
  GIT_CONFIG_KEY_2: 'credential.https://github.com.helper',
  GIT_CONFIG_VALUE_2: '!gh auth git-credential',
};

const unmanagedGitEnv = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'credential.helper',
  GIT_CONFIG_VALUE_0: '',
  GIT_ASKPASS: '',
  GIT_TERMINAL_PROMPT: '0',
};

const expectedManagedGitEnv = { ...unmanagedGitEnv, ...managedGithubEnv };

test('credential-free GitHub HTTPS operations continue when managed authentication is unavailable', async () => {
  const unavailable = new Error('Managed GitHub authentication is not usable: unauthenticated');
  unavailable.name = 'GithubAuthenticationUnavailableError';

  const result = await githubUrlCredentialOptions(
    'https://github.com/owner/public.git',
    async () => { throw unavailable; },
  );

  assert.deepEqual(result.env, unmanagedGitEnv);
});

test('credential-free Git environment overrides repository-local core.askPass', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX askpass regression uses an executable shell script.');
    return;
  }
  const root = mkdtempSync(join(tmpdir(), 'github-no-credential-'));
  const repo = join(root, 'repo');
  const askpass = join(root, 'askpass.sh');
  const marker = join(root, 'askpass-invoked');
  writeFileSync(askpass, `#!/bin/sh\nprintf invoked > "${marker}"\nprintf secret\n`);
  chmodSync(askpass, 0o700);

  try {
    assert.equal(spawnSync('git', ['init', repo]).status, 0);
    assert.equal(spawnSync('git', ['-C', repo, 'config', 'core.askPass', askpass]).status, 0);
    const { env } = await githubUrlCredentialOptions('https://example.com/repo.git', undefined);

    spawnSync('git', ['-C', repo, 'credential', 'fill'], {
      env: { ...process.env, ...env },
      input: 'protocol=https\nhost=example.com\n\n',
      encoding: 'utf8',
    });

    assert.equal(existsSync(marker), false, 'repository-local core.askPass was executed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('approved PR creation receives the managed GitHub CLI environment', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'github-pr-env-'));
  const approvalService = createInMemoryCodingApprovalService();
  const calls: ExecCall[] = [];
  const sandbox = createRecordingSandbox(workspaceRoot, calls);
  const createPr = getTool(createCodingGitTools({
    workspaceRoot,
    sandbox,
    approvalService,
    githubGitEnv: async () => managedGithubEnv,
  }), 'coding_github_create_pr');

  try {
    await approveAndExecute(createPr, {
      taskId: 'create-managed-pr',
      title: 'Managed auth PR',
      body: 'Use the managed GitHub account.',
      draft: false,
    }, approvalService);

    const ghCall = calls.find((call) => call.file === 'gh' && call.args[0] === 'pr' && call.args[1] === 'create');
    assert.ok(ghCall, 'expected the approved PR tool to invoke gh pr create');
    assert.deepEqual(ghCall.env, managedGithubEnv);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('git push validates every configured push URL before injecting managed credentials', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'github-push-url-'));
  const approvalService = createInMemoryCodingApprovalService();
  const calls: ExecCall[] = [];
  let credentialRequests = 0;
  const sandbox = createRecordingSandbox(workspaceRoot, calls, (args) => {
    if (args[0] === 'remote' && args[1] === 'get-url') {
      return args.includes('--push')
        ? 'https://github.com/owner/repo.git\nhttps://attacker.example/owner/repo.git\n'
        : 'https://github.com/owner/repo.git\n';
    }
    return '';
  });
  const push = getTool(createCodingGitTools({
    workspaceRoot,
    sandbox,
    approvalService,
    githubGitEnv: async () => {
      credentialRequests += 1;
      return managedGithubEnv;
    },
  }), 'coding_git_push');

  try {
    await approveAndExecute(push, {
      taskId: 'push-attacker-url',
      remote: 'origin',
      branch: 'feature/managed-auth',
    }, approvalService);

    assert.equal(
      calls.some((call) => call.args.join('\u0000') === ['remote', 'get-url', '--push', '--all', 'origin'].join('\u0000')),
      true,
      'push must inspect every push destination rather than the fetch URL',
    );
    assert.equal(credentialRequests, 0);
    assert.deepEqual(calls.find((call) => call.args[0] === 'push')?.env, unmanagedGitEnv);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('clone injects managed credentials only for credential-free GitHub HTTPS URLs on the default port', async () => {
  const harness = createRepoHarness();
  const clone = getTool(harness.tools, 'coding_repo_clone');

  try {
    await approveAndExecute(clone, {
      taskId: 'clone-managed',
      remoteUrl: 'https://github.com/owner/private.git',
      slug: 'managed',
    }, harness.approvalService);
    assert.deepEqual(harness.calls.findLast((call) => call.args[0] === 'clone')?.env, expectedManagedGitEnv);

    for (const [taskId, remoteUrl, slug] of [
      ['clone-port', 'https://github.com:8443/owner/private.git', 'port'],
    ] as const) {
      await approveAndExecute(clone, { taskId, remoteUrl, slug }, harness.approvalService);
      assert.deepEqual(harness.calls.findLast((call) => call.args[0] === 'clone')?.env, unmanagedGitEnv);
    }
    await assert.rejects(
      clone.execute({
        taskId: 'clone-credentials',
        remoteUrl: 'https://user:secret@github.com/owner/private.git',
        slug: 'credentials',
      }),
      /embedded credentials/i,
    );
  } finally {
    harness.cleanup();
  }
});

test('fetch injects managed credentials only for eligible GitHub HTTPS remotes', async () => {
  const harness = createRepoHarness({
    managed: 'https://github.com/owner/private.git',
    port: 'https://github.com:8443/owner/private.git',
    credentials: 'https://user:secret@github.com/owner/private.git',
  });
  const fetch = getTool(harness.tools, 'coding_repo_fetch');

  try {
    for (const [remote, expectedEnv] of [
      ['managed', expectedManagedGitEnv],
      ['port', unmanagedGitEnv],
    ] as const) {
      await approveAndExecute(fetch, {
        taskId: `fetch-${remote}`,
        remote,
      }, harness.approvalService);
      assert.deepEqual(harness.calls.findLast((call) => call.args[0] === 'fetch')?.env, expectedEnv);
    }
    await assertApprovedRemoteRejected(fetch, {
      taskId: 'fetch-credentials',
      remote: 'credentials',
    }, harness.approvalService, /embedded credentials/i);
  } finally {
    harness.cleanup();
  }
});

test('sync applies the same credential boundary to its prune fetch and pull commands', async () => {
  const harness = createRepoHarness({
    managed: 'https://github.com/owner/private.git',
    port: 'https://github.com:8443/owner/private.git',
    credentials: 'https://user:secret@github.com/owner/private.git',
  });
  const sync = getTool(harness.tools, 'coding_repo_sync');

  try {
    for (const [remote, expectedEnv] of [
      ['managed', expectedManagedGitEnv],
      ['port', unmanagedGitEnv],
    ] as const) {
      const callStart = harness.calls.length;
      await approveAndExecute(sync, {
        taskId: `sync-${remote}`,
        remote,
        branch: 'main',
        prune: true,
      }, harness.approvalService);
      const networkCalls = harness.calls
        .slice(callStart)
        .filter((call) => call.args[0] === 'fetch' || call.args[0] === 'pull');
      assert.equal(networkCalls.length, 2);
      assert.deepEqual(networkCalls.map((call) => call.env), [expectedEnv, expectedEnv]);
    }
    await assertApprovedRemoteRejected(sync, {
      taskId: 'sync-credentials',
      remote: 'credentials',
      branch: 'main',
      prune: true,
    }, harness.approvalService, /embedded credentials/i);
  } finally {
    harness.cleanup();
  }
});

test('code-only worker initialization does not validate or create unused GitHub auth storage', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'coding-worker-lazy-auth-'));
  const approvalRoot = mkdtempSync(join(tmpdir(), 'coding-worker-lazy-approvals-'));
  const invalidAuthRoot = join(workspaceRoot, 'must-not-be-created');

  try {
    const profile = await createCodingWorkerSubagent({
      workspaceRoot,
      approvalRoot,
      githubAuthRoot: invalidAuthRoot,
      githubClient: {} as GitHubClient,
    });
    const listFiles = getTool(profile.tools ?? [], 'coding_repo_list_files');
    const result = JSON.parse(await listFiles.execute({})) as { files: string[] };
    assert.deepEqual(result.files, []);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(approvalRoot, { recursive: true, force: true });
  }
});

test('model-facing worker commands strip all Git config overrides and raw GitHub credentials', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'coding-worker-env-sanitize-'));
  const approvalRoot = mkdtempSync(join(tmpdir(), 'coding-worker-env-approvals-'));
  const authRoot = mkdtempSync(join(tmpdir(), 'coding-worker-env-auth-'));

  try {
    const profile = await createCodingWorkerSubagent({
      workspaceRoot,
      approvalRoot,
      githubAuthRoot: authRoot,
      githubClient: {} as GitHubClient,
      env: {
        GH_TOKEN: 'raw-gh-token',
        GITHUB_TOKEN: 'raw-github-token',
        GOROMBO_GITHUB_AUTH_ROOT: authRoot,
        GH_CONFIG_DIR: '/attacker/gh',
        GIT_CONFIG_COUNT: '3',
        GIT_CONFIG_KEY_2: 'credential.helper',
        GIT_CONFIG_VALUE_2: '!attacker-helper',
        GIT_CONFIG_PARAMETERS: "'credential.helper=!attacker-helper'",
      },
    });
    const shell = getTool(profile.tools ?? [], 'coding_shell_run');
    const result = JSON.parse(await shell.execute({ command: 'env' })) as { stdout: string };

    for (const forbiddenName of [
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'GOROMBO_GITHUB_AUTH_ROOT',
      'GH_CONFIG_DIR',
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_KEY_2',
      'GIT_CONFIG_VALUE_2',
      'GIT_CONFIG_PARAMETERS',
    ]) {
      assert.doesNotMatch(result.stdout, new RegExp(`^${forbiddenName}=`, 'm'));
    }
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(approvalRoot, { recursive: true, force: true });
    rmSync(authRoot, { recursive: true, force: true });
  }
});

test('default GitHub client operations fail closed when managed authentication is invalid', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'coding-worker-github-gate-'));
  const approvalRoot = mkdtempSync(join(tmpdir(), 'coding-worker-github-gate-approvals-'));
  let statusCalls = 0;
  let envCalls = 0;
  const githubAuthService = {
    status: async () => {
      statusCalls += 1;
      return {
        state: 'invalid',
        profile: 'default',
        hostname: 'github.com',
        credentialSource: 'gh_token',
        checkedAt: new Date().toISOString(),
        failureCode: 'github_auth_status_failed',
      } as const;
    },
    createGhEnv: async () => {
      envCalls += 1;
      return { GH_TOKEN: 'must-not-reach-client' };
    },
    createGitCredentialEnv: async () => ({}),
    start: async () => { throw new Error('not used'); },
    cancel: async () => { throw new Error('not used'); },
  } satisfies GithubAuthService;

  try {
    const profile = await createCodingWorkerSubagent({
      workspaceRoot,
      approvalRoot,
      githubAuthService,
    } as Parameters<typeof createCodingWorkerSubagent>[0] & { githubAuthService: GithubAuthService });
    const read = getTool(profile.tools ?? [], 'coding_github_read_context');
    const result = JSON.parse(await read.execute({
      taskId: 'github-invalid-auth',
      owner: 'owner',
      repo: 'repo',
      issueNumber: 1,
    })) as { actions: Array<{ payload: { available: boolean } }> };

    assert.equal(result.actions[0]?.payload.available, false);
    assert.equal(statusCalls, 1);
    assert.equal(envCalls, 0);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(approvalRoot, { recursive: true, force: true });
  }
});

interface ExecCall {
  file: string;
  args: string[];
  env?: Record<string, string>;
}

function createRecordingSandbox(
  workspaceRoot: string,
  calls: ExecCall[],
  stdoutForArgs: (args: string[]) => string = () => '',
): CodingSandboxRuntime {
  return {
    workspaceRoot,
    existsWorkspace: async () => false,
    mkdirWorkspace: async () => undefined,
    resolveWorkspacePath: (path: string) => join(workspaceRoot, path),
    execFile: async (file: string, args: string[], options?: { env?: Record<string, string> }) => {
      calls.push({ file, args, env: options?.env });
      return { exitCode: 0, stdout: stdoutForArgs(args), stderr: '' };
    },
  } as unknown as CodingSandboxRuntime;
}

function createRepoHarness(remoteUrls: Record<string, string> = {}) {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'github-repo-boundary-'));
  const approvalService = createInMemoryCodingApprovalService();
  const calls: ExecCall[] = [];
  const sandbox = createRecordingSandbox(workspaceRoot, calls, (args) => {
    if (args[0] === 'remote' && args[1] === 'get-url') {
      return `${remoteUrls[args.at(-1) ?? ''] ?? ''}\n`;
    }
    return '';
  });
  const tools = createCodingRepoWorkflowTools({
    workspaceRoot,
    sandbox,
    repoRegistry: new InMemoryCodingRepoRegistry(),
    approvalService,
    githubGitEnv: async () => managedGithubEnv,
  });
  return {
    tools,
    calls,
    approvalService,
    cleanup: () => rmSync(workspaceRoot, { recursive: true, force: true }),
  };
}

async function approveAndExecute(
  tool: ExecutableTool,
  args: Record<string, unknown>,
  approvalService: CodingApprovalService,
): Promise<unknown> {
  const blocked = JSON.parse(await tool.execute(args)) as {
    request?: { id?: string };
    actions?: Array<{ payload?: { request?: { id?: string } } }>;
  };
  const requestId = blocked.request?.id ?? blocked.actions?.[0]?.payload?.request?.id;
  assert.ok(requestId, 'expected the first mutating tool call to request approval');
  await approvalService.recordDecision({
    requestId,
    approved: true,
    decidedBy: 'credential-boundary-test',
    principal: { id: 'credential-boundary-test', roles: ['operator'] },
  });
  return JSON.parse(await tool.execute(args));
}

async function assertApprovedRemoteRejected(
  tool: ExecutableTool,
  args: Record<string, unknown>,
  approvalService: CodingApprovalService,
  expected: RegExp,
): Promise<void> {
  const blocked = JSON.parse(await tool.execute(args)) as { request?: { id?: string } };
  assert.ok(blocked.request?.id);
  await approvalService.recordDecision({
    requestId: blocked.request.id,
    approved: true,
    decidedBy: 'credential-boundary-test',
    principal: { id: 'credential-boundary-test', roles: ['operator'] },
  });
  await assert.rejects(tool.execute(args), expected);
}

interface ExecutableTool {
  execute(args: Record<string, unknown>): Promise<string>;
}

function getTool(tools: ToolDefinition[], name: string): ExecutableTool {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `Missing ${name} tool.`);
  return tool as unknown as ExecutableTool;
}
