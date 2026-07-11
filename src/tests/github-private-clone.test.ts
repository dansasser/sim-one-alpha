import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createInMemoryCodingApprovalService } from '../engine/workers/coding-worker/approvals/approval-service.js';
import { InMemoryCodingRepoRegistry } from '../engine/workers/coding-worker/repo/repo-registry.js';
import { createCodingRepoWorkflowTools } from '../engine/workers/coding-worker/tools/coding-repo-workflow-tools.js';
import type { CodingSandboxRuntime } from '../engine/workers/coding-worker/tools/sandbox-runtime.js';

test('private GitHub HTTPS clones receive managed credentials while other remotes do not', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'github-private-clone-'));
  const approvalService = createInMemoryCodingApprovalService();
  const calls: Array<{ args: string[]; env?: Record<string, string> }> = [];
  const sandbox = {
    workspaceRoot,
    existsWorkspace: async () => false,
    mkdirWorkspace: async () => undefined,
    resolveWorkspacePath: (path: string) => join(workspaceRoot, path),
    execFile: async (_file: string, args: string[], options?: { env?: Record<string, string> }) => {
      calls.push({ args, env: options?.env });
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  } as unknown as CodingSandboxRuntime;
  const tools = createCodingRepoWorkflowTools({
    workspaceRoot,
    sandbox,
    repoRegistry: new InMemoryCodingRepoRegistry(),
    approvalService,
    githubGitEnv: async () => ({
      GH_CONFIG_DIR: '/managed/gh',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_1: '!gh auth git-credential',
    }),
  });
  const clone = getTool(tools, 'coding_repo_clone');

  try {
    const githubBlocked = JSON.parse(await clone.execute({
      taskId: 'clone-github', remoteUrl: 'https://github.com/owner/private.git', slug: 'private',
    })) as { request: { id: string } };
    await approvalService.recordDecision({
      requestId: githubBlocked.request.id,
      approved: true,
      decidedBy: 'operator-1',
      principal: { id: 'operator-1', roles: ['operator'] },
    });
    await clone.execute({ taskId: 'clone-github', remoteUrl: 'https://github.com/owner/private.git', slug: 'private' });
    assert.deepEqual(calls.at(-1)?.env, {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GH_CONFIG_DIR: '/managed/gh',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_1: '!gh auth git-credential',
    });

    const gitlabBlocked = JSON.parse(await clone.execute({
      taskId: 'clone-gitlab', remoteUrl: 'https://gitlab.com/owner/project.git', slug: 'gitlab-project',
    })) as { request: { id: string } };
    await approvalService.recordDecision({
      requestId: gitlabBlocked.request.id,
      approved: true,
      decidedBy: 'operator-1',
      principal: { id: 'operator-1', roles: ['operator'] },
    });
    await clone.execute({ taskId: 'clone-gitlab', remoteUrl: 'https://gitlab.com/owner/project.git', slug: 'gitlab-project' });
    assert.deepEqual(calls.at(-1)?.env, {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_TERMINAL_PROMPT: '0',
    });
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

function getTool(tools: unknown[], name: string): {
  execute(args: { taskId: string; remoteUrl: string; slug: string }): Promise<string>;
} {
  const tool = (tools as Array<{ name: string; execute: unknown }>).find((candidate) => candidate.name === name);
  assert.ok(tool, `Missing ${name} tool.`);
  return tool as unknown as { execute(args: { taskId: string; remoteUrl: string; slug: string }): Promise<string> };
}
