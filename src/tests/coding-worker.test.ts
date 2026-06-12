import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import orchestratorAgent from '../agents/orchestrator.js';
import { evaluateCodingApproval, createCodingApprovalRequest } from '../workers/coding-worker/approvals/approval-policy.js';
import { createCodingGitHubTools } from '../workers/coding-worker/github/github-tools.js';
import { InMemoryCodingProgressReporter } from '../workers/coding-worker/events/progress-reporter.js';
import { createCodingWorkerEvent } from '../workers/coding-worker/events/coding-worker-events.js';
import { createCodingWorkerSessionPlan } from '../workers/coding-worker/session/child-session-names.js';
import {
  codingWorkerInternalSubagentNames,
  createCodingWorkerInternalSubagents,
} from '../workers/coding-worker/subagents/index.js';
import { runCodingRepoPreflight } from '../workers/coding-worker/repo/preflight.js';
import { createCodingVerificationPlan } from '../workers/coding-worker/repo/verification.js';
import { createCodingGitTools } from '../workers/coding-worker/tools/coding-git-tools.js';
import { createCodingRepoTools } from '../workers/coding-worker/tools/coding-repo-tools.js';
import { createFlueCodingSubagentDelegate } from '../workers/coding-worker/workflow/coordination.js';
import { runCodingTaskWorkflow } from '../workers/coding-worker/workflow/coding-task.js';
import { assertCodingWorkerCanComplete } from '../workers/coding-worker/workflow/result-schema.js';
import type { ToolDefinition } from '@flue/runtime';

test('coding worker internal subagents are worker-local profiles with distinct context identities', () => {
  const subagents = createCodingWorkerInternalSubagents('ollama-cloud/minimax-m3');

  assert.deepEqual(
    subagents.map((agent) => agent.name),
    [...codingWorkerInternalSubagentNames],
  );
  assert.equal(subagents.every((agent) => agent.model === 'ollama-cloud/minimax-m3'), true);

  for (const subagent of subagents) {
    assert.match(subagent.instructions ?? '', /worker-local internal subagent/);
    assert.match(subagent.instructions ?? '', /coding-worker lead/);
    assert.doesNotMatch(subagent.instructions ?? '', /human operator as the immediate principal/i);
  }
});

test('coding worker child session names are stable and scoped by task', () => {
  const plan = createCodingWorkerSessionPlan('Fix Bug #42', 'Support Session');

  assert.equal(plan.leadSessionName, 'support-session');
  assert.equal(plan.childSessions.triage, 'support-session:triage');
  assert.equal(plan.childSessions.implementer, 'support-session:implementer');
  assert.equal(plan.childSessions['test-debug'], 'support-session:test-debug');
  assert.equal(plan.childSessions['code-review'], 'support-session:code-review');
  assert.equal(plan.childSessions.github, 'support-session:github');
});

test('coding worker live delegate uses Flue task delegation to worker-local subagent names', async () => {
  const calls: Array<{ text: string; agent?: string }> = [];
  const delegate = createFlueCodingSubagentDelegate({
    task: async (text: string, options?: { agent?: string }) => {
      calls.push({ text, agent: options?.agent });
      return {
        text: 'triage complete',
        model: { provider: 'test', id: 'test' },
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
    },
  } as never);

  const sessionPlan = createCodingWorkerSessionPlan('task-delegate', 'delegate-session');
  const result = await delegate('triage', {
    task: {
      taskId: 'task-delegate',
      text: 'Classify this change.',
    },
    sessionPlan,
    preflight: {
      repoPath: process.cwd(),
      packageManager: 'pnpm',
      scripts: {},
      verificationPlan: [],
    },
    plan: [],
  });

  assert.equal(calls[0]?.agent, 'coding-worker-triage');
  assert.match(calls[0]?.text ?? '', /delegate-session:triage/);
  assert.equal(result.summary, 'triage complete');
});

test('public coding worker events reject raw thinking or internal prompt fields', () => {
  assert.doesNotThrow(() =>
    createCodingWorkerEvent({
      type: 'coding.plan.updated',
      taskId: 'task-1',
      summary: 'Plan updated.',
      evidence: ['package.json'],
    }),
  );

  assert.throws(
    () =>
      createCodingWorkerEvent({
        type: 'coding.plan.updated',
        taskId: 'task-1',
        summary: 'Bad event.',
        rawPrompt: 'private prompt',
      } as never),
    /must not expose private model context/,
  );
});

test('repo preflight detects pnpm and exact configured verification scripts', () => {
  const repoPath = createTempRepo({
    scripts: {
      'test:unit': 'node scripts/run-unit-tests.mjs',
      typecheck: 'tsc -p tsconfig.json --noEmit',
      build: 'flue build --target node',
      test: 'pnpm run test:unit && pnpm run build',
    },
  });

  try {
    writeFileSync(join(repoPath, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');

    const preflight = runCodingRepoPreflight(repoPath);

    assert.equal(preflight.packageManager, 'pnpm');
    assert.deepEqual(
      preflight.verificationPlan.map((command) => command.command),
      [
        'corepack pnpm run test:unit',
        'corepack pnpm run typecheck',
        'corepack pnpm run build',
        'corepack pnpm test',
      ],
    );
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test('verification planner keeps named check scripts exact when present', () => {
  const plan = createCodingVerificationPlan({
    packageManager: 'pnpm',
    scripts: {
      check: 'biome check .',
      lint: 'eslint .',
      test: 'node --test',
    },
  });

  assert.equal(plan.some((command) => command.command === 'corepack pnpm run lint'), true);
  assert.equal(plan.some((command) => command.command === 'corepack pnpm run check'), true);
  assert.equal(plan.some((command) => command.command === 'corepack pnpm test'), true);
});

test('GitHub side effects are approval-gated and GitHub read tool is mockable', async () => {
  const approvalRequest = createCodingApprovalRequest({
    taskId: 'task-github',
    actionType: 'github.pr.create',
    summary: 'Create a PR',
    reason: 'Ready for review.',
    risk: 'Publishes branch and opens remote PR state.',
  });

  assert.deepEqual(evaluateCodingApproval(approvalRequest), {
    allowed: false,
    requiresApproval: true,
    reason: 'Action requires explicit approval before execution.',
  });

  const tools = createCodingGitHubTools({
    async getIssue() {
      return { number: 7, title: 'Fix parser', state: 'OPEN' };
    },
    async getPullRequest() {
      return { number: 8, title: 'Parser PR', state: 'OPEN' };
    },
    async listPullRequestChecks() {
      return [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }];
    },
  });
  const readContext = tools.find((tool) => tool.name === 'coding_github_read_context');

  assert.ok(readContext);
  const output = JSON.parse(
    await readContext.execute({
      owner: 'dansasser',
      repo: 'astro-flue-agent',
      issueNumber: 7,
      pullRequestNumber: 8,
    }),
  ) as { issue?: { title?: string }; checks?: Array<{ conclusion?: string }> };

  assert.equal(output.issue?.title, 'Fix parser');
  assert.equal(output.checks?.[0]?.conclusion, 'SUCCESS');
});

test('coding worker repo tools edit files and run verification in a temp repo', async () => {
  const repoPath = createExecutableTempRepo();

  try {
    const tools = createCodingRepoTools({ repoPath });
    const shell = getTool(tools, 'coding_shell_run');
    const patch = getTool(tools, 'coding_repo_apply_patch');
    const read = getTool(tools, 'coding_repo_read_file');

    const failing = JSON.parse(await shell.execute({ command: 'node test.js' })) as { exitCode: number };
    assert.equal(failing.exitCode, 1);

    const patchResult = JSON.parse(
      await patch.execute({
        path: 'index.js',
        edits: [{ oldText: 'return 41;', newText: 'return 42;', expectedOccurrences: 1 }],
      }),
    ) as { replacements: number };
    assert.equal(patchResult.replacements, 1);

    const passing = JSON.parse(await shell.execute({ command: 'node test.js' })) as { exitCode: number };
    assert.equal(passing.exitCode, 0);

    const output = JSON.parse(await read.execute({ path: 'index.js' })) as { content: string };
    assert.match(output.content, /return 42/);
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test('orchestrator exposes repo execution only through the coding-worker lead', async () => {
  const repoPath = createExecutableTempRepo();

  try {
    const config = await orchestratorAgent.initialize({
      id: 'coding-worker-orchestrator-surface',
      env: {
        ...createModelEnv(),
        GOROMBO_CODING_REPO_PATH: repoPath,
      },
      payload: undefined,
    });

    assert.equal(config.tools?.some((tool) => tool.name === 'coding_repo_apply_patch'), false);
    assert.equal(config.tools?.some((tool) => tool.name === 'coding_shell_run'), false);

    const codingWorker = config.subagents?.find((agent) => agent.name === 'coding-worker');
    assert.ok(codingWorker);

    const patch = getTool(codingWorker.tools ?? [], 'coding_repo_apply_patch');
    const shell = getTool(codingWorker.tools ?? [], 'coding_shell_run');

    await patch.execute({
      path: 'index.js',
      edits: [{ oldText: 'return 41;', newText: 'return 42;', expectedOccurrences: 1 }],
    });
    const output = JSON.parse(await shell.execute({ command: 'node test.js' })) as { exitCode: number };

    assert.equal(output.exitCode, 0);
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test('coding worker shell tool blocks git and GitHub writes without approval', async () => {
  const repoPath = createExecutableTempRepo();

  try {
    const shell = getTool(createCodingRepoTools({ repoPath }), 'coding_shell_run');
    const output = JSON.parse(await shell.execute({ command: 'git push origin main' })) as {
      blocked?: boolean;
      approvalAction?: string;
    };

    assert.equal(output.blocked, true);
    assert.equal(output.approvalAction, 'git.write');
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test('coding worker git commit tool requires approval and commits when approved', async () => {
  const repoPath = createGitTempRepo();

  try {
    writeFileSync(join(repoPath, 'index.js'), 'exports.answer = function answer() { return 42; };\n');
    const commit = getTool(createCodingGitTools({ repoPath }), 'coding_git_commit');

    const blocked = JSON.parse(
      await commit.execute({
        taskId: 'task-commit',
        message: 'Update answer',
        paths: ['index.js'],
        approvalRequestId: 'task-commit:wrong',
        approved: true,
      }),
    ) as { blocked?: boolean };
    assert.equal(blocked.blocked, true);

    const output = JSON.parse(
      await commit.execute({
        taskId: 'task-commit',
        message: 'Update answer',
        paths: ['index.js'],
        approvalRequestId: 'task-commit:git.commit',
        approved: true,
      }),
    ) as { status?: string };
    assert.equal(output.status, 'committed');

    const log = execFileSync('git', ['log', '--oneline', '-1'], { cwd: repoPath, encoding: 'utf8' });
    assert.match(log, /Update answer/);
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test('coding worker GitHub PR creation tool is approval-gated', async () => {
  const repoPath = createGitTempRepo();

  try {
    const createPr = getTool(createCodingGitTools({ repoPath }), 'coding_github_create_pr');
    const output = JSON.parse(
      await createPr.execute({
        taskId: 'task-pr',
        title: 'Test PR',
        body: 'Test body',
        approvalRequestId: 'task-pr:github.pr.create',
        approved: false,
        approvalReason: 'not approved',
      }),
    ) as { blocked?: boolean };

    assert.equal(output.blocked, true);
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test('coding task workflow emits public progress and blocks completion without verification evidence', async () => {
  const reporter = new InMemoryCodingProgressReporter();
  const result = await runCodingTaskWorkflow(
    {
      taskId: 'task-no-verification',
      text: 'Implement a feature',
      repoPath: process.cwd(),
    },
    {
      reporter,
      preflight: () => ({
        repoPath: process.cwd(),
        packageManager: 'pnpm',
        scripts: {
          typecheck: 'tsc -p tsconfig.json --noEmit',
          build: 'flue build --target node',
          test: 'pnpm run test:unit && pnpm run build',
        },
        verificationPlan: createCodingVerificationPlan({
          packageManager: 'pnpm',
          scripts: {
            typecheck: 'tsc -p tsconfig.json --noEmit',
            build: 'flue build --target node',
            test: 'pnpm run test:unit && pnpm run build',
          },
        }),
      }),
    },
  );

  assert.equal(result.status, 'blocked');
  assert.match(result.summary, /verification evidence/);
  assert.equal(reporter.events()[0]?.type, 'coding.task.accepted');
  assert.equal(reporter.events().some((event) => event.type === 'coding.plan.updated'), true);
  assert.equal(reporter.events().some((event) => event.type === 'coding.blocked'), true);
});

test('coding task workflow edits a temp repo and completes only after verification passes', async () => {
  const repoPath = createExecutableTempRepo();

  try {
    const result = await runCodingTaskWorkflow({
      taskId: 'task-with-real-edit',
      text: 'Fix answer implementation.',
      repoPath,
      fileEdits: [
        {
          path: 'index.js',
          oldText: 'return 41;',
          newText: 'return 42;',
          expectedOccurrences: 1,
        },
      ],
      verificationCommands: [
        {
          name: 'unit',
          command: 'node test.js',
          required: true,
          reason: 'Temp repo unit verification must pass.',
        },
      ],
    });

    assert.equal(result.status, 'completed');
    assert.match(readFileSync(join(repoPath, 'index.js'), 'utf8'), /return 42/);
    assert.equal(result.subagentResults.some((item) => item.subagent === 'implementer'), true);
    assert.equal(result.publicEvents.some((event) => JSON.stringify(event).includes('coding.verification.completed')), true);
    assert.doesNotThrow(() => assertCodingWorkerCanComplete(result));
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test('coding task workflow debug loop patches after a failed verification run', async () => {
  const repoPath = createExecutableTempRepo();

  try {
    const result = await runCodingTaskWorkflow({
      taskId: 'task-debug-loop',
      text: 'Fix answer implementation through debug loop.',
      repoPath,
      fileEdits: [
        {
          path: 'index.js',
          oldText: 'return 41;',
          newText: 'return 40;',
          expectedOccurrences: 1,
        },
      ],
      debugEdits: [
        {
          path: 'index.js',
          oldText: 'return 40;',
          newText: 'return 42;',
          expectedOccurrences: 1,
        },
      ],
      verificationCommands: [
        {
          name: 'unit',
          command: 'node test.js',
          required: true,
          reason: 'Temp repo unit verification must pass after debug.',
        },
      ],
    });

    assert.equal(result.status, 'completed');
    assert.match(readFileSync(join(repoPath, 'index.js'), 'utf8'), /return 42/);
    assert.equal(result.verification.evidence.some((item) => item.status === 'failed'), true);
    assert.equal(result.verification.evidence.some((item) => item.status === 'passed'), true);
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test('coding task workflow can complete with passing required verification evidence', async () => {
  const repoPath = createExecutableTempRepo();

  try {
  const result = await runCodingTaskWorkflow(
    {
      taskId: 'task-with-verification',
      text: 'Implement a feature',
      repoPath,
      filesToInspect: ['index.js'],
      verificationCommands: [
        {
          name: 'unit',
          command: 'node -e "process.exit(0)"',
          required: true,
          reason: 'Synthetic verification evidence must pass.',
        },
      ],
    },
    {
      preflight: () => ({
        repoPath,
        packageManager: 'pnpm',
        scripts: {
          typecheck: 'tsc -p tsconfig.json --noEmit',
          build: 'flue build --target node',
          test: 'pnpm run test:unit && pnpm run build',
        },
        verificationPlan: createCodingVerificationPlan({
          packageManager: 'pnpm',
          scripts: {
            typecheck: 'tsc -p tsconfig.json --noEmit',
            build: 'flue build --target node',
            test: 'pnpm run test:unit && pnpm run build',
          },
        }),
      }),
    },
  );

  assert.equal(result.status, 'completed');
  assert.doesNotThrow(() => assertCodingWorkerCanComplete(result));
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

function createTempRepo(input: { scripts: Record<string, string> }) {
  const repoPath = mkdtempSync(join(tmpdir(), 'coding-worker-repo-'));
  writeFileSync(
    join(repoPath, 'package.json'),
    JSON.stringify(
      {
        scripts: input.scripts,
      },
      null,
      2,
    ),
  );
  return repoPath;
}

function createExecutableTempRepo() {
  const repoPath = createTempRepo({
    scripts: {
      test: 'node test.js',
    },
  });
  writeFileSync(join(repoPath, 'index.js'), 'exports.answer = function answer() { return 41; };\n');
  writeFileSync(
    join(repoPath, 'test.js'),
    "const { answer } = require('./index.js');\nif (answer() !== 42) {\n  console.error(`expected 42, got ${answer()}`);\n  process.exit(1);\n}\n",
  );
  return repoPath;
}

function createGitTempRepo() {
  const repoPath = createExecutableTempRepo();
  execFileSync('git', ['init'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.email', 'coding-worker@example.test'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.name', 'Coding Worker Test'], { cwd: repoPath });
  execFileSync('git', ['add', '.'], { cwd: repoPath });
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoPath });
  return repoPath;
}

function getTool(tools: ToolDefinition[], name: string) {
  const tool = tools.find((item) => item.name === name);
  assert.ok(tool);
  return tool;
}

function createModelEnv(): Record<string, string> {
  return {
    OLLAMA_API_KEY: 'test-key',
    CODEX_BRAIN_LOCAL_API_KEY: 'test-key',
    CODEX_BRAIN_LOCAL_API_URL: 'https://dt1.example.test/v1',
  };
}
