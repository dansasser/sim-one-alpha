import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
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
import { runCodingTaskWorkflow } from '../workers/coding-worker/workflow/coding-task.js';
import { assertCodingWorkerCanComplete } from '../workers/coding-worker/workflow/result-schema.js';

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

test('coding task workflow can complete only with passing required verification evidence', async () => {
  const result = await runCodingTaskWorkflow(
    {
      taskId: 'task-with-verification',
      text: 'Implement a feature',
      repoPath: process.cwd(),
    },
    {
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
      verificationEvidence: [
        { command: 'corepack pnpm run typecheck', status: 'passed', exitCode: 0, summary: 'Typecheck passed.' },
        { command: 'corepack pnpm run build', status: 'passed', exitCode: 0, summary: 'Build passed.' },
        { command: 'corepack pnpm test', status: 'passed', exitCode: 0, summary: 'Tests passed.' },
      ],
    },
  );

  assert.equal(result.status, 'completed');
  assert.doesNotThrow(() => assertCodingWorkerCanComplete(result));
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
