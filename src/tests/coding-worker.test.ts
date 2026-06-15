import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import * as v from 'valibot';
import orchestratorAgent from '../agents/orchestrator.js';
import { CodingFileEditSchema, CodingImplementerResultSchema } from '../schemas/coding-worker.js';
import { evaluateCodingApproval, createCodingApprovalRequest } from '../workers/coding-worker/approvals/approval-policy.js';
import {
  createFileCodingApprovalService,
  createInMemoryCodingApprovalService,
} from '../workers/coding-worker/approvals/approval-service.js';
import { createCodingGitHubTools } from '../workers/coding-worker/github/github-tools.js';
import { GhCliGitHubClient } from '../workers/coding-worker/github/gh-cli-client.js';
import type { GitHubClient } from '../workers/coding-worker/github/github-client.js';
import {
  createCodingWorkerSubagent,
  resolveCodingWorkerWorkspaceRoot,
} from '../workers/coding-worker/coding-worker.js';
import { InMemoryCodingProgressReporter } from '../workers/coding-worker/events/progress-reporter.js';
import { createCodingWorkerEvent } from '../workers/coding-worker/events/coding-worker-events.js';
import { createOrchestratorProgressUpdate } from '../workers/coding-worker/events/orchestrator-bridge.js';
import { createCodingWorkerSessionPlan } from '../workers/coding-worker/session/child-session-names.js';
import {
  codingWorkerInternalSubagentNames,
  createCodingWorkerInternalSubagents,
} from '../workers/coding-worker/subagents/index.js';
import { parseCodingCodeReviewText } from '../workers/coding-worker/subagents/code-review/code-review-agent.js';
import { readPackageScripts, runCodingRepoPreflight } from '../workers/coding-worker/repo/preflight.js';
import { parseGitStatusShort } from '../workers/coding-worker/repo/git-state.js';
import { InMemoryCodingRepoRegistry } from '../workers/coding-worker/repo/repo-registry.js';
import {
  packageManagerRunCommand,
  packageManagerTestCommand,
} from '../workers/coding-worker/repo/package-manager.js';
import { createCodingVerificationPlan } from '../workers/coding-worker/repo/verification.js';
import { createCodingGitTools } from '../workers/coding-worker/tools/coding-git-tools.js';
import { createCodingImplementerTools } from '../workers/coding-worker/tools/coding-implementer-tools.js';
import {
  applyCodingEditTransaction,
  createCodingEditTransaction,
  createCodingRepoTools,
} from '../workers/coding-worker/tools/coding-repo-tools.js';
import { createCodingRepoWorkflowTools } from '../workers/coding-worker/tools/coding-repo-workflow-tools.js';
import { createCodingTestDebugTools } from '../workers/coding-worker/tools/coding-test-debug-tools.js';
import { evaluateCodingShellCommand } from '../workers/coding-worker/tools/command-policy.js';
import { createFlueLocalCodingSandbox } from '../workers/coding-worker/tools/sandbox-runtime.js';
import { resolveCodingWorkspaceTarget } from '../workers/coding-worker/repo/workspace-target.js';
import { JsonFileCodingTaskRunStore } from '../workers/coding-worker/session/task-run-store.js';
import { createFlueCodingSubagentDelegate } from '../workers/coding-worker/workflow/coordination.js';
import { createInitialCodingPlan } from '../workers/coding-worker/workflow/coding-task.js';
import { createInitialPlan, replan } from '../workers/coding-worker/workflow/planning.js';
import { runCodingWorkerLoop, createInitialLoopState, createLoopCheckpoint } from '../workers/coding-worker/workflow/loop.js';
import { assertCodingWorkerCanComplete } from '../workers/coding-worker/workflow/result-schema.js';
import type { CodingSubagentKind, CodingSubagentRunResult, CodingWorkerTaskRequest } from '../workers/coding-worker/types.js';
import type { CodingTaskSubagentRequest } from '../workers/coding-worker/workflow/coding-task.js';
import type { ToolDefinition } from '@flue/runtime';

test('coding worker internal subagents are worker-local profiles with distinct context identities', () => {
  const subagents = createCodingWorkerInternalSubagents({ model: 'ollama-cloud/minimax-m3' });

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

test('coding worker child session names avoid placeholder collisions for empty inputs', () => {
  const first = createCodingWorkerSessionPlan('', '');
  const second = createCodingWorkerSessionPlan('', '');
  const invalidSession = createCodingWorkerSessionPlan('Fix Bug #42', '---');

  assert.match(first.leadSessionName, /^coding-task-[a-z0-9]{10}$/);
  assert.match(invalidSession.leadSessionName, /^coding-fix-bug-42-[a-z0-9]{10}$/);
  assert.notEqual(first.leadSessionName, second.leadSessionName);
  assert.equal(new Set([first.leadSessionName, ...Object.values(first.childSessions)]).size, 6);
  assert.equal(
    Object.values(first.childSessions).every((sessionName) =>
      sessionName.startsWith(`${first.leadSessionName}:`),
    ),
    true,
  );
});

test('code review text parser extracts findings with severity, file, and line range', () => {
  const text = `## Review

- [BLOCKER] \`src/utils.ts:14-16\` — unsafe parsing of user input
- [WARNING] \`src/index.ts:42\` missing input validation
- [INFO] README updated

Approved: false`;

  const result = parseCodingCodeReviewText(text);

  assert.equal(result.approved, false);
  assert.equal(result.findings.length, 3);

  const [blocker, warning, info] = result.findings;
  assert.equal(blocker.severity, 'blocker');
  assert.equal(blocker.file, 'src/utils.ts');
  assert.equal(blocker.lineStart, 14);
  assert.equal(blocker.lineEnd, 16);
  assert.match(blocker.message, /unsafe parsing/);

  assert.equal(warning.severity, 'warning');
  assert.equal(warning.file, 'src/index.ts');
  assert.equal(warning.lineStart, 42);
  assert.equal(warning.lineEnd, undefined);
  assert.match(warning.message, /missing input validation/);

  assert.equal(info.severity, 'info');
  assert.equal(info.file, undefined);
  assert.equal(info.lineStart, undefined);
  assert.match(info.message, /README updated/);
});

test('code review text parser infers approval from blockers unless explicitly overridden', () => {
  const onlyWarnings = parseCodingCodeReviewText('- [WARNING] `src/a.ts:1` style issue\n');
  assert.equal(onlyWarnings.approved, true);
  assert.equal(onlyWarnings.findings.length, 1);

  const onlyBlocker = parseCodingCodeReviewText('- [BLOCKER] `src/b.ts:2` crash\n');
  assert.equal(onlyBlocker.approved, false);

  const explicitApproved = parseCodingCodeReviewText(
    '- [WARNING] `src/c.ts:3` nit\napproved: true',
  );
  assert.equal(explicitApproved.approved, true);

  const explicitRejected = parseCodingCodeReviewText(
    '- [INFO] `src/d.ts:4` note\napproved: no',
  );
  assert.equal(explicitRejected.approved, false);
  assert.equal(explicitRejected.findings.length, 1);
});

test('coding worker live delegate uses Flue task delegation to worker-local subagent names', async () => {
  const workspaceRoot = createTempWorkspace();
  const calls: Array<{ text: string; agent?: string; result?: boolean }> = [];
  const delegate = createFlueCodingSubagentDelegate({
    task: async (text: string, options?: { agent?: string; result?: unknown }) => {
      calls.push({ text, agent: options?.agent, result: Boolean(options?.result) });
      const agent = options?.agent;
      if (agent === 'coding-worker-triage') {
        return {
          data: {
            plan: [],
            filesToInspect: [],
            recommendedExecutionPath: 'implementer',
          },
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
      }
      return {
        text: 'subagent complete',
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

  try {
    const sessionPlan = createCodingWorkerSessionPlan('task-delegate', 'delegate-session');
    const result = await delegate('triage', {
      task: {
        taskId: 'task-delegate',
        text: 'Classify this change.',
        workspaceRoot,
        targetKind: 'workspace',
        verificationCommands: [
          {
            name: 'custom',
            command: 'node custom-check.js',
            required: true,
          },
        ],
      },
      sessionPlan,
      preflight: {
        repoPath: workspaceRoot,
        packageManager: 'pnpm',
        scripts: {},
        verificationPlan: [
          {
            name: 'preflight',
            command: 'node preflight-check.js',
            required: true,
            reason: 'Preflight fallback.',
            status: 'pending',
          },
        ],
      },
      plan: [],
    });

    assert.equal(calls[0]?.agent, 'coding-worker-triage');
    assert.equal(calls[0]?.result, true);
    assert.match(calls[0]?.text ?? '', /delegate-session:triage/);
    assert.match(calls[0]?.text ?? '', /workspaceRoot/);
    assert.match(calls[0]?.text ?? '', /node custom-check\.js/);
    assert.doesNotMatch(calls[0]?.text ?? '', /node preflight-check\.js/);
    assert.match(result.summary, /Triage selected execution path/);
    assert.equal(result.structuredOutput?.type, 'triage');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('coding workspace resolver stores projects and repos under the runtime workspace root', () => {
  const workspaceRoot = createTempWorkspace();

  try {
    const projectTarget = resolveCodingWorkspaceTarget({
      workspaceRoot,
      targetKind: 'project',
      projectSlug: 'New App',
    });
    const repoTarget = resolveCodingWorkspaceTarget({
      workspaceRoot,
      targetKind: 'repo',
      projectSlug: 'existing-repo',
    });

    assert.equal(projectTarget.projectRelativePath, 'projects/new-app');
    assert.equal(projectTarget.scopePath, join(workspaceRoot, 'projects', 'new-app'));
    assert.equal(repoTarget.projectRelativePath, 'repos/existing-repo');
    assert.equal(repoTarget.scopePath, join(workspaceRoot, 'repos', 'existing-repo'));
    assert.throws(
      () =>
        resolveCodingWorkspaceTarget({
          workspaceRoot,
          targetKind: 'project',
          projectSlug: '.',
        }),
      /letter or number/,
    );
    assert.throws(
      () =>
        resolveCodingWorkspaceTarget({
          workspaceRoot,
          targetKind: 'repo',
          projectSlug: '..',
        }),
      /letter or number/,
    );
    assert.throws(
      () =>
        resolveCodingWorkspaceTarget({
          workspaceRoot,
          targetKind: 'project',
          projectRelativePath: '../outside',
        }),
      /escape|relative/,
    );
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('coding worker workspace root defaults to src/workspace/ when no env var is set', () => {
  const root = resolveCodingWorkerWorkspaceRoot({});
  assert.equal(root, resolve('src/workspace'));
});

test('coding worker workspace root env overrides are respected in order', () => {
  const defaultRoot = resolveCodingWorkerWorkspaceRoot({});
  assert.equal(defaultRoot, resolve('src/workspace'));

  assert.equal(
    resolveCodingWorkerWorkspaceRoot({ GOROMBO_WORKSPACE_ROOT: '/custom/a' }),
    '/custom/a',
  );
  assert.equal(
    resolveCodingWorkerWorkspaceRoot({
      GOROMBO_CODING_WORKSPACE_ROOT: '/custom/b',
    }),
    '/custom/b',
  );
  assert.equal(
    resolveCodingWorkerWorkspaceRoot({
      GOROMBO_CODING_REPO_PATH: '/custom/c',
    }),
    '/custom/c',
  );
  assert.equal(
    resolveCodingWorkerWorkspaceRoot({
      GOROMBO_WORKSPACE_ROOT: '/override/a',
      GOROMBO_CODING_WORKSPACE_ROOT: '/override/b',
      GOROMBO_CODING_REPO_PATH: '/override/c',
    }),
    '/override/a',
  );
});

test('coding workspace resolver recognizes src/workspace/repos/ as a valid repo scope', () => {
  const workspaceRoot = resolveCodingWorkerWorkspaceRoot({});
  const repoTarget = resolveCodingWorkspaceTarget({
    workspaceRoot,
    targetKind: 'repo',
    projectSlug: 'example',
  });

  assert.equal(repoTarget.projectRelativePath, 'repos/example');
  assert.equal(repoTarget.scopePath, join(workspaceRoot, 'repos', 'example'));
  assert.equal(repoTarget.targetKind, 'repo');
  assert.equal(repoTarget.usedLegacyRepoPath, false);
});

test('coding shell command policy blocks nested git and GitHub write bypasses', () => {
  const blockedCases: Array<{ command: string; approvalAction: string }> = [
    { command: 'bash -c "git push origin main"', approvalAction: 'git.write' },
    { command: "sh -c 'gh pr merge 13'", approvalAction: 'github.write' },
    { command: 'echo $(gh pr merge 13)', approvalAction: 'github.write' },
    { command: 'echo `git push origin main`', approvalAction: 'git.write' },
    { command: 'git status\ngit push origin main', approvalAction: 'git.write' },
    { command: 'gh api repos/example/example/issues -f title=x -f body=x', approvalAction: 'github.write' },
    { command: 'gh api repos/example/example/issues --field title=x', approvalAction: 'github.write' },
    { command: 'gh api repos/example/example/rulesets --input ruleset.json', approvalAction: 'github.write' },
  ];

  for (const blockedCase of blockedCases) {
    const result = evaluateCodingShellCommand(blockedCase.command);
    assert.equal(result.allowed, false, blockedCase.command);
    assert.equal(result.approvalAction, blockedCase.approvalAction);
  }

  assert.equal(evaluateCodingShellCommand('bash -c "git status --short"').allowed, true);
  assert.equal(evaluateCodingShellCommand('echo $(gh pr view 13)').allowed, true);
  assert.equal(evaluateCodingShellCommand('gh api repos/example/example/issues --method GET -f state=open').allowed, true);
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

test('orchestrator progress bridge revalidates public coding worker events', () => {
  const safeEvent = createCodingWorkerEvent({
    type: 'coding.action.completed',
    taskId: 'task-safe-event',
    summary: 'Patched file.',
  });

  assert.equal(
    createOrchestratorProgressUpdate('task-safe-event', [safeEvent]).latestSummary,
    'Patched file.',
  );
  assert.throws(
    () =>
      createOrchestratorProgressUpdate('task-unsafe-event', [
        {
          ...safeEvent,
          rawPrompt: 'private prompt',
        } as never,
      ]),
    /must not expose private model context/,
  );
});

test('coding worker plan includes GitHub stage when GitHub context is present', () => {
  const plan = createInitialCodingPlan({
    taskId: 'task-github-plan',
    text: 'Prepare PR work.',
    github: {
      pullRequestNumber: 13,
    },
  });

  assert.equal(plan.some((item) => item.owner === 'github'), true);
});

test('createInitialPlan produces explicit plan items with context', () => {
  const plan = createInitialPlan(
    {
      taskId: 'task-plan-context',
      text: 'Fix parser bug.',
      filesToInspect: ['src/parser.ts', 'src/lexer.ts'],
    },
    {
      preflight: { repoPath: '/tmp/repo', packageManager: 'pnpm' },
      filesToInspect: ['src/parser.ts', 'src/lexer.ts'],
    },
  );

  assert.equal(plan.length, 4);
  assert.equal(plan[0].owner, 'triage');
  assert.match(plan[0].description, /src\/parser\.ts/);
  assert.match(plan[0].description, /src\/lexer\.ts/);
  assert.equal(plan[1].owner, 'implementer');
  assert.match(plan[1].description, /pnpm/);
  assert.equal(plan[2].owner, 'test-debug');
  assert.equal(plan[3].owner, 'code-review');
});

test('createInitialPlan adds GitHub stage when GitHub context is provided', () => {
  const plan = createInitialPlan(
    {
      taskId: 'task-plan-github',
      text: 'Update PR.',
    },
    {
      github: { issueNumber: 7 },
    },
  );

  assert.equal(plan.some((item) => item.owner === 'github'), true);
});

test('replan marks failed step blocked and surfaces review findings', () => {
  const state = createMinimalLoopState('task-replan-review', [
    { id: 'task-replan-review:review', description: 'Review', owner: 'code-review', status: 'in_progress' },
    { id: 'task-replan-review:implement', description: 'Implement', owner: 'implementer', status: 'completed' },
  ]);

  const plan = replan(state, {
    step: 'code-review',
    summary: 'Review rejected the change.',
    reviewFindings: [
      { severity: 'blocker', message: 'Missing input validation.', file: 'src/index.ts', lineStart: 42 },
      { severity: 'warning', message: 'Consider a named constant.' },
    ],
  });

  assert.equal(plan.some((item) => item.id === 'task-replan-review:replan-1'), true);
  assert.equal(plan.find((item) => item.owner === 'code-review')?.status, 'blocked');
  assert.equal(plan.find((item) => item.owner === 'implementer')?.status, 'in_progress');
  assert.equal(plan.filter((item) => item.owner === 'implementer').length, 2);
  assert.equal(
    plan.some((item) => item.description.includes('Missing input validation') && item.description.includes('src/index.ts:42')),
    true,
  );
  assert.equal(plan.some((item) => item.description.includes('Consider a named constant')), false);
});

test('replan surfaces failed verification evidence as test-debug items', () => {
  const state = createMinimalLoopState('task-replan-verify', [
    { id: 'task-replan-verify:verify', description: 'Verify', owner: 'test-debug', status: 'blocked' },
    { id: 'task-replan-verify:implement', description: 'Implement', owner: 'implementer', status: 'completed' },
  ]);

  const plan = replan(state, {
    step: 'test-debug',
    summary: 'Required verification did not pass.',
    verificationEvidence: [
      { command: 'node test.js', status: 'failed', exitCode: 1, summary: 'expected 42, got 40' },
      { command: 'node lint.js', status: 'passed', exitCode: 0, summary: 'ok' },
    ],
  });

  assert.equal(plan.some((item) => item.id === 'task-replan-verify:replan-1'), true);
  assert.equal(plan.find((item) => item.owner === 'test-debug' && item.id.startsWith('task-replan-verify:replan-1:verify-'))?.description.includes('node test.js'), true);
  assert.equal(plan.filter((item) => item.owner === 'test-debug').length, 2);
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

test('repo preflight returns no scripts for invalid package json', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'coding-worker-invalid-package-'));

  try {
    writeFileSync(join(repoPath, 'package.json'), '{ invalid json');

    assert.deepEqual(readPackageScripts(repoPath), {});
    assert.deepEqual(runCodingRepoPreflight(repoPath).scripts, {});
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

test('test-debug tools expose a submit result tool for structured output', () => {
  const tools = createCodingTestDebugTools();
  const submit = getTool(tools, 'coding_test_debug_submit_result');

  assert.ok(submit);
  assert.match(submit.description ?? '', /CodingTestDebugResult/i);
});

test('test-debug submit result tool returns debug edits from fake failing verification output', async () => {
  const tools = createCodingTestDebugTools();
  const submit = getTool(tools, 'coding_test_debug_submit_result');

  const fakeFailureOutput = [
    'expected 42, got 40',
    'at Object.answer (/workspace/index.js:2:42)',
  ].join('\n');

  const output = JSON.parse(
    await submit.execute({
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
          reason: 'Confirm the debug edit resolves the failing assertion.',
        },
      ],
      analysis: `Unit test failed with: ${fakeFailureOutput}. The answer function returns 40 instead of 42; updating the return value fixes the assertion.`,
    }),
  ) as { status?: string; result?: { debugEdits: unknown[]; verificationCommands: unknown[]; analysis: string } };

  assert.equal(output.status, 'submitted');
  assert.equal(output.result?.debugEdits.length, 1);
  assert.equal(output.result?.verificationCommands.length, 1);
  assert.match(output.result?.analysis ?? '', /40 instead of 42/);
});

test('package manager command builders fail closed when package manager is unknown', () => {
  assert.throws(
    () => packageManagerRunCommand('unknown', 'test'),
    /unknown package manager/i,
  );
  assert.throws(
    () => packageManagerTestCommand('unknown'),
    /unknown package manager/i,
  );
  assert.deepEqual(
    createCodingVerificationPlan({
      packageManager: 'unknown',
      scripts: {
        test: 'node test.js',
      },
    }),
    [],
  );
});

test('git status parser preserves paths before removing status columns', () => {
  assert.deepEqual(
    parseGitStatusShort('## main\n M src/index.ts\nR  old.ts -> src/new.ts\n?? README.md\n').changedFiles,
    ['src/index.ts', 'src/new.ts', 'README.md'],
  );
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
    status: 'pending',
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
  ) as { actions: Array<{ action: string; payload: { issue?: { title?: string }; checks?: Array<{ conclusion?: string }> } }> };

  assert.equal(output.actions.length, 1);
  assert.equal(output.actions[0]?.action, 'read_context');
  assert.equal(output.actions[0]?.payload.issue?.title, 'Fix parser');
  assert.equal(output.actions[0]?.payload.checks?.[0]?.conclusion, 'SUCCESS');
});

test('approval service persists trusted decisions and rejects untrusted actors', async () => {
  const workspaceRoot = createTempWorkspace();

  try {
    const service = createFileCodingApprovalService(workspaceRoot);
    const request = await service.createRequest({
      taskId: 'task-approval',
      actionType: 'github.pr.update',
      summary: 'Update PR body.',
      reason: 'PR body is remote review context.',
      risk: 'This mutates remote GitHub state.',
      target: 'owner/repo#13',
    });

    assert.match(request.id, /^task-approval:github\.pr\.update:/);
    assert.deepEqual(await service.evaluateRequest(request), {
      allowed: false,
      requiresApproval: true,
      reason: 'Action requires explicit approval before execution.',
      status: 'pending',
    });
    await assert.rejects(
      () =>
        service.recordDecision({
          requestId: request.id,
          approved: true,
          decidedBy: '',
          principal: { id: '', roles: ['operator'] },
        }),
      /trusted decidedBy actor/,
    );

    await assert.rejects(
      () =>
        service.recordDecision({
          requestId: request.id,
          approved: true,
          decidedBy: 'operator',
          principal: { id: 'operator', roles: ['viewer'] },
        }),
      /role required to record approval decisions/,
    );

    await assert.rejects(
      () =>
        service.recordDecision({
          requestId: request.id,
          approved: true,
          decidedBy: 'operator',
          principal: { id: 'other-operator', roles: ['operator'] },
        }),
      /does not match the authenticated principal/,
    );

    await service.recordDecision({
      requestId: request.id,
      approved: true,
      decidedBy: 'operator',
      principal: { id: 'operator', roles: ['operator'] },
    });
    assert.deepEqual(await service.evaluateRequest(request), {
      allowed: true,
      requiresApproval: true,
      reason: 'Action approved.',
      status: 'approved',
    });

    const reloaded = createFileCodingApprovalService(workspaceRoot);
    assert.equal((await reloaded.getRecord(request.id))?.status, 'approved');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('concurrent file-store approval service serializes create and recordDecision', async () => {
  const workspaceRoot = createTempWorkspace();

  try {
    const serviceA = createFileCodingApprovalService(workspaceRoot);
    const serviceB = createFileCodingApprovalService(workspaceRoot);

    const created: Awaited<ReturnType<typeof serviceA.createRequest>>[] = [];
    for (let i = 0; i < 5; i += 1) {
      created.push(
        await serviceA.createRequest({
          taskId: 'task-concurrent',
          actionType: 'git.push',
          summary: `Push branch ${i}`,
          reason: 'Pushes remote refs.',
          risk: 'This mutates remote repository state.',
        }),
      );
    }

    await Promise.all([
      ...created.map((request, index) =>
        index % 2 === 0
          ? serviceA.recordDecision({ requestId: request.id, approved: true, decidedBy: 'operator-a', principal: { id: 'operator-a', roles: ['operator'] } })
          : serviceB.recordDecision({ requestId: request.id, approved: false, decidedBy: 'operator-b', principal: { id: 'operator-b', roles: ['operator'] } }),
      ),
      serviceA.createRequest({
        taskId: 'task-concurrent-extra',
        actionType: 'repo.sync',
        summary: 'Concurrent sync.',
        reason: 'Syncing mutates local refs.',
        risk: 'This mutates local repository state.',
      }),
    ]);

    const reloaded = createFileCodingApprovalService(workspaceRoot);
    for (const request of created) {
      const record = await reloaded.getRecord(request.id);
      assert.ok(record, `record should exist for ${request.id}`);
      assert.equal(
        record.status,
        (await serviceA.getRecord(request.id))?.status,
        'all service instances see the same persisted status',
      );
    }
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('approval service expires stale requests fail closed', async () => {
  const service = createInMemoryCodingApprovalService();
  const request = await service.createRequest({
    taskId: 'task-expired',
    actionType: 'git.push',
    summary: 'Push branch.',
    reason: 'Pushes remote refs.',
    risk: 'This mutates remote repository state.',
    expiresAt: '2000-01-01T00:00:00.000Z',
  });

  assert.equal((await service.evaluateRequest(request)).status, 'expired');
  assert.equal((await service.getRecord(request.id))?.status, 'expired');
  await assert.rejects(
    () =>
      service.recordDecision({
        requestId: request.id,
        approved: true,
        decidedBy: 'operator',
        principal: { id: 'operator', roles: ['operator'] },
      }),
    /not pending: expired/,
  );
});

test('GitHub CLI client validates repository identifiers before running gh', async () => {
  const client = new GhCliGitHubClient();

  await assert.rejects(
    () => client.getIssue('--bad', 'repo', 1),
    /Invalid GitHub owner/,
  );
  await assert.rejects(
    () => client.getPullRequest('owner', 'bad repo', 1),
    /Invalid GitHub repo/,
  );
  await assert.rejects(
    () => client.listPullRequestChecks('owner', 'repo', 0),
    /Invalid GitHub pullRequestNumber/,
  );
});

test('GitHub CLI client requests valid PR check fields and maps them to worker summaries', async () => {
  let capturedArgs: string[] = [];
  const client = new GhCliGitHubClient(undefined, undefined, async (args: string[]) => {
    capturedArgs = args;
    return [
      {
        name: 'unit',
        state: 'SUCCESS',
        bucket: 'pass',
        link: 'https://github.example/checks/unit',
      },
    ];
  });

  const checks = await client.listPullRequestChecks('owner', 'repo', 13);

  assert.deepEqual(capturedArgs, [
    'pr',
    'checks',
    '13',
    '--repo',
    'owner/repo',
    '--json',
    'name,state,bucket,link',
  ]);
  assert.deepEqual(checks, [
    {
      name: 'unit',
      status: 'SUCCESS',
      conclusion: 'pass',
      detailsUrl: 'https://github.example/checks/unit',
    },
  ]);
});

test('coding worker profile wires GitHub read context with a client and supports repoPath-only scope', async () => {
  const project = createWorkspaceProject();

  try {
    writeFileSync(join(project.repoPath, 'README.md'), '# scoped repo\n');
    const subagent = await createCodingWorkerSubagent({
      repoPath: project.repoPath,
      githubClient: {
        async getIssue() {
          return { number: 7, title: 'Scoped issue', state: 'OPEN' };
        },
        async getPullRequest() {
          return { number: 8, title: 'Scoped PR', state: 'OPEN' };
        },
        async listPullRequestChecks() {
          return [{ name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }];
        },
      },
    });

    const readContext = getTool(subagent.tools ?? [], 'coding_github_read_context');
    const context = JSON.parse(
      await readContext.execute({
        owner: 'dansasser',
        repo: 'astro-flue-agent',
        issueNumber: 7,
        pullRequestNumber: 8,
      }),
    ) as {
      actions: Array<{
        action: string;
        payload: {
          available?: boolean;
          issue?: { title?: string };
          pullRequest?: { title?: string };
          checks?: Array<{ conclusion?: string }>;
        };
      }>;
    };

    assert.equal(context.actions.length, 1);
    const payload = context.actions[0]?.payload;
    assert.equal(payload?.available, true);
    assert.equal(payload?.issue?.title, 'Scoped issue');
    assert.equal(payload?.pullRequest?.title, 'Scoped PR');
    assert.equal(payload?.checks?.[0]?.conclusion, 'SUCCESS');

    const readFile = getTool(subagent.tools ?? [], 'coding_repo_read_file');
    const file = JSON.parse(await readFile.execute({ path: 'README.md' })) as { content?: string };
    assert.equal(file.content, '# scoped repo\n');
  } finally {
    rmSync(project.workspaceRoot, { recursive: true, force: true });
  }
});

test('GitHub tools read extended PR context and gate PR updates through approval service', async () => {
  const approvalService = createInMemoryCodingApprovalService();
  let updateCount = 0;
  const tools = createCodingGitHubTools({
    approvalService,
    client: {
      async getIssue() {
        return { number: 7, title: 'Issue', state: 'OPEN' };
      },
      async getPullRequest() {
        return { number: 13, title: 'PR', state: 'OPEN', baseRef: 'main', headRef: 'branch' };
      },
      async listPullRequestChecks() {
        return [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }];
      },
      async listPullRequestComments() {
        return [{ id: 'comment-1', author: 'reviewer', body: 'Looks good.' }];
      },
      async listPullRequestReviewThreads() {
        return [{ id: 'thread-1', isResolved: false, isOutdated: false, comments: [] }];
      },
      async updatePullRequest() {
        updateCount += 1;
        return { status: 'updated' };
      },
    },
  });

  const readContext = getTool(tools, 'coding_github_read_context');
  const context = JSON.parse(
    await readContext.execute({
      owner: 'dansasser',
      repo: 'astro-flue-agent',
      issueNumber: 7,
      pullRequestNumber: 13,
    }),
  ) as {
    actions: Array<{
      action: string;
      payload: {
        comments?: Array<{ id: string }>;
        reviewThreads?: Array<{ id: string }>;
      };
    }>;
  };
  assert.equal(context.actions.length, 1);
  assert.equal(context.actions[0]?.payload.comments?.[0]?.id, 'comment-1');
  assert.equal(context.actions[0]?.payload.reviewThreads?.[0]?.id, 'thread-1');

  const updatePr = getTool(tools, 'coding_github_update_pr');
  const blocked = JSON.parse(
    await updatePr.execute({
      taskId: 'task-gh-update',
      owner: 'dansasser',
      repo: 'astro-flue-agent',
      pullRequestNumber: 13,
      body: 'Updated body',
    }),
  ) as {
    actions: Array<{
      action: string;
      payload: { blocked?: boolean; request?: { id: string }; status?: string };
    }>;
  };
  assert.equal(blocked.actions[0]?.payload.blocked, true);
  assert.ok(blocked.actions[0]?.payload.request?.id);
  assert.equal(updateCount, 0);

  const requestId = blocked.actions[0]?.payload.request?.id;
  assert.ok(requestId);
  await approvalService.recordDecision({
    requestId,
    approved: true,
    decidedBy: 'operator',
    principal: { id: 'operator', roles: ['operator'] },
  });
  const approved = JSON.parse(
    await updatePr.execute({
      taskId: 'task-gh-update',
      owner: 'dansasser',
      repo: 'astro-flue-agent',
      pullRequestNumber: 13,
      body: 'Updated body',
    }),
  ) as {
    actions: Array<{
      action: string;
      payload: { status?: string };
    }>;
  };
  assert.equal(approved.actions[0]?.payload.status, 'updated');
  assert.equal(updateCount, 1);
});

test('GitHub tools verify explicit PR base, head, draft status, and checks', async () => {
  const tools = createCodingGitHubTools({
    client: {
      async getIssue() {
        return { number: 7, title: 'Issue', state: 'OPEN' };
      },
      async getPullRequest() {
        return {
          number: 13,
          title: 'Runtime PR',
          state: 'OPEN',
          baseRef: 'codex/coding-worker-agent-subsystem',
          headRef: 'codex/coding-worker-runtime-approvals',
          isDraft: false,
        };
      },
      async listPullRequestChecks() {
        return [{ name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }];
      },
    },
  });
  const verifyPr = getTool(tools, 'coding_github_verify_pr');

  const verified = JSON.parse(
    await verifyPr.execute({
      owner: 'dansasser',
      repo: 'astro-flue-agent',
      pullRequestNumber: 13,
      expectedBase: 'codex/coding-worker-agent-subsystem',
      expectedHead: 'codex/coding-worker-runtime-approvals',
      expectedDraft: false,
      requireChecksPassed: true,
    }),
  ) as {
    actions: Array<{
      action: string;
      payload: { verified?: boolean; mismatches?: string[] };
    }>;
  };
  assert.equal(verified.actions[0]?.payload.verified, true);
  assert.deepEqual(verified.actions[0]?.payload.mismatches, []);

  const mismatch = JSON.parse(
    await verifyPr.execute({
      owner: 'dansasser',
      repo: 'astro-flue-agent',
      pullRequestNumber: 13,
      expectedBase: 'main',
      expectedDraft: true,
    }),
  ) as {
    actions: Array<{
      action: string;
      payload: { verified?: boolean; mismatches?: string[] };
    }>;
  };
  assert.equal(mismatch.actions[0]?.payload.verified, false);
  assert.match(mismatch.actions[0]?.payload.mismatches?.join('\n') ?? '', /Expected base main/);
  assert.match(mismatch.actions[0]?.payload.mismatches?.join('\\n') ?? '', /Expected draft status true/);
});

test('GitHub CLI client lists issues and pull requests with normalized summaries', async () => {
  const client = new GhCliGitHubClient(undefined, undefined, async (args) => {
    if (args[0] === 'issue') {
      return [
        { number: 1, title: 'Bug', state: 'OPEN', url: 'https://github.example/issues/1' },
        { number: 2, title: 'Feature', state: 'CLOSED', url: 'https://github.example/issues/2' },
      ];
    }
    return [
      {
        number: 10,
        title: 'Fix',
        state: 'OPEN',
        url: 'https://github.example/pull/10',
        headRefName: 'fix',
        baseRefName: 'main',
        isDraft: true,
      },
    ];
  });

  const issues = await client.listIssues('owner', 'repo', 'open');
  const pullRequests = await client.listPullRequests('owner', 'repo', 'open');

  assert.deepEqual(issues, [
    { number: 1, title: 'Bug', state: 'OPEN', url: 'https://github.example/issues/1' },
    { number: 2, title: 'Feature', state: 'CLOSED', url: 'https://github.example/issues/2' },
  ]);
  assert.deepEqual(pullRequests, [
    {
      number: 10,
      title: 'Fix',
      state: 'OPEN',
      url: 'https://github.example/pull/10',
      headRef: 'fix',
      baseRef: 'main',
      headRefName: 'fix',
      baseRefName: 'main',
      isDraft: true,
    },
  ]);
});

test('GitHub CLI client creates a local branch from a PR', async () => {
  let capturedArgs: string[] = [];
  const mockClient: GitHubClient = {
    async getIssue() {
      throw new Error('not implemented');
    },
    async getPullRequest() {
      throw new Error('not implemented');
    },
    async listPullRequestChecks() {
      return [];
    },
    async createBranchFromPullRequest(input) {
      capturedArgs = ['pr', 'checkout', String(input.pullRequestNumber), '--repo', `${input.owner}/${input.repo}`, '--branch', input.branchName];
      return { status: 'created', branchName: input.branchName, stdout: '' };
    },
  };

  const result = await mockClient.createBranchFromPullRequest!({
    owner: 'owner',
    repo: 'repo',
    pullRequestNumber: 13,
    branchName: 'pr-13-branch',
  });

  assert.deepEqual(capturedArgs, ['pr', 'checkout', '13', '--repo', 'owner/repo', '--branch', 'pr-13-branch']);
  assert.equal(result.status, 'created');
  assert.equal(result.branchName, 'pr-13-branch');
});

test('GitHub CLI client creates line-specific review comments with required fields', async () => {
  const mockClient: GitHubClient = {
    async getIssue() {
      throw new Error('not implemented');
    },
    async getPullRequest() {
      throw new Error('not implemented');
    },
    async listPullRequestChecks() {
      return [];
    },
    async createReviewComment(input) {
      return {
        status: 'created',
        id: 'review-comment-1',
        stdout: JSON.stringify({ body: input.body, path: input.path, line: input.line }),
      };
    },
  };

  const result = await mockClient.createReviewComment!({
    owner: 'owner',
    repo: 'repo',
    pullRequestNumber: 13,
    body: 'Consider this edge case.',
    path: 'src/index.ts',
    line: 42,
  });

  assert.equal(result.status, 'created');
  assert.equal(result.id, 'review-comment-1');
});

test('GitHub CLI client reruns a workflow run by id', async () => {
  const mockClient: GitHubClient = {
    async getIssue() {
      throw new Error('not implemented');
    },
    async getPullRequest() {
      throw new Error('not implemented');
    },
    async listPullRequestChecks() {
      return [];
    },
    async rerunCheck(input) {
      return {
        status: 'rerun',
        runId: input.runId,
        stdout: `Requested rerun of run ${input.runId}`,
      };
    },
  };

  const result = await mockClient.rerunCheck!({
    owner: 'owner',
    repo: 'repo',
    runId: '12345',
    rerunFailedJobs: true,
  });

  assert.equal(result.status, 'rerun');
  assert.equal(result.runId, '12345');
});

test('GitHub CLI client forks a repository', async () => {
  const mockClient: GitHubClient = {
    async getIssue() {
      throw new Error('not implemented');
    },
    async getPullRequest() {
      throw new Error('not implemented');
    },
    async listPullRequestChecks() {
      return [];
    },
    async forkRepository(input) {
      return {
        status: 'forked',
        forkName: input.forkName ?? `${input.owner}/${input.repo}`,
        stdout: '',
      };
    },
  };

  const result = await mockClient.forkRepository!({
    owner: 'owner',
    repo: 'repo',
    defaultBranchOnly: true,
  });

  assert.equal(result.status, 'forked');
  assert.equal(result.forkName, 'owner/repo');
});

test('GitHub tools list issues and pull requests through the configured client', async () => {
  const tools = createCodingGitHubTools({
    client: {
      async getIssue() {
        throw new Error('not implemented');
      },
      async getPullRequest() {
        throw new Error('not implemented');
      },
      async listPullRequestChecks() {
        return [];
      },
      async listIssues() {
        return [{ number: 1, title: 'Issue', state: 'OPEN' }];
      },
      async listPullRequests() {
        return [{ number: 2, title: 'PR', state: 'OPEN', headRef: 'feature', baseRef: 'main' }];
      },
    },
  });

  const listIssues = getTool(tools, 'coding_github_list_issues');
  const issuesOutput = JSON.parse(await listIssues.execute({ owner: 'owner', repo: 'repo' })) as {
    actions: Array<{ action: string; payload: { issues?: Array<{ title: string }> } }>;
  };
  assert.equal(issuesOutput.actions[0]?.action, 'list_issues');
  assert.equal(issuesOutput.actions[0]?.payload.issues?.[0]?.title, 'Issue');

  const listPrs = getTool(tools, 'coding_github_list_prs');
  const prsOutput = JSON.parse(await listPrs.execute({ owner: 'owner', repo: 'repo' })) as {
    actions: Array<{ action: string; payload: { pullRequests?: Array<{ baseRef?: string }> } }>;
  };
  assert.equal(prsOutput.actions[0]?.action, 'list_prs');
  assert.equal(prsOutput.actions[0]?.payload.pullRequests?.[0]?.baseRef, 'main');
});

test('GitHub tools do not default PR base when omitted', async () => {
  let updatedBase: string | undefined = 'initial';
  const approvalService = createInMemoryCodingApprovalService();
  const tools = createCodingGitHubTools({
    approvalService,
    client: {
      async getIssue() {
        throw new Error('not implemented');
      },
      async getPullRequest() {
        throw new Error('not implemented');
      },
      async listPullRequestChecks() {
        return [];
      },
      async getDefaultBranch() {
        return 'main';
      },
      async updatePullRequest(input) {
        updatedBase = input.base;
        return { status: 'updated' };
      },
    },
  });

  const blocked = JSON.parse(
    await getTool(tools, 'coding_github_update_pr').execute({
      taskId: 'task-base-default',
      owner: 'owner',
      repo: 'repo',
      pullRequestNumber: 13,
      body: 'Update',
    }),
  ) as {
    actions: Array<{ payload: { blocked?: boolean; request?: { id: string } } }>;
  };
  const requestId = blocked.actions[0]?.payload.request?.id;
  assert.ok(requestId);
  await approvalService.recordDecision({
    requestId,
    approved: true,
    decidedBy: 'operator',
    principal: { id: 'operator', roles: ['operator'] },
  });
  await getTool(tools, 'coding_github_update_pr').execute({
    taskId: 'task-base-default',
    owner: 'owner',
    repo: 'repo',
    pullRequestNumber: 13,
    body: 'Update',
  });

  assert.equal(updatedBase, undefined);
});


test('coding worker tools create projects under the workspace root and scope file edits there', async () => {
  const workspaceRoot = createTempWorkspace();

  try {
    const workspaceTools = createCodingRepoTools({ workspaceRoot, targetKind: 'workspace' });
    const createProject = getTool(workspaceTools, 'coding_project_create');
    const created = JSON.parse(
      await createProject.execute({
        name: 'Answer App',
        directoryKind: 'projects',
        initializeReadme: true,
      }),
    ) as { projectRelativePath: string; projectPath: string; targetKind: string };

    assert.equal(created.targetKind, 'project');
    assert.equal(created.projectRelativePath, 'projects/answer-app');
    assert.equal(created.projectPath, join(workspaceRoot, 'projects', 'answer-app'));
    assert.equal(existsSync(join(workspaceRoot, 'projects', 'answer-app', 'README.md')), true);

    writeExecutableProjectFiles(created.projectPath);

    const projectTools = createCodingRepoTools({
      workspaceRoot,
      targetKind: 'project',
      projectRelativePath: created.projectRelativePath,
    });
    const shell = getTool(projectTools, 'coding_shell_run');
    const patch = getTool(projectTools, 'coding_repo_apply_patch');
    const read = getTool(projectTools, 'coding_repo_read_file');

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
    await assert.rejects(() => read.execute({ path: '../README.md' }), /escapes coding-worker/);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('coding worker edit transaction applies multi-file writes and patches atomically', async () => {
  const workspaceRoot = createTempWorkspace();

  try {
    const sandbox = await createFlueLocalCodingSandbox({
      workspaceRoot,
      targetKind: 'workspace',
    });
    writeFileSync(join(workspaceRoot, 'a.js'), 'const a = 1;\n');
    writeFileSync(join(workspaceRoot, 'b.js'), 'const b = 2;\n');

    const transaction = createCodingEditTransaction('tx-success', [
      { path: 'a.js', oldText: 'const a = 1;', newText: 'const a = 2;', expectedOccurrences: 1 },
      { path: 'b.js', oldText: 'const b = 2;', newText: 'const b = 3;', expectedOccurrences: 1 },
    ], [{ path: 'c.js', content: 'const c = 4;\n' }]);

    const result = await applyCodingEditTransaction(sandbox, transaction);

    assert.equal(result.status, 'applied');
    assert.equal(result.results.length, 3);
    assert.equal(result.results.every((r) => r.status === 'applied'), true);
    assert.equal(readFileSync(join(workspaceRoot, 'a.js'), 'utf8'), 'const a = 2;\n');
    assert.equal(readFileSync(join(workspaceRoot, 'b.js'), 'utf8'), 'const b = 3;\n');
    assert.equal(readFileSync(join(workspaceRoot, 'c.js'), 'utf8'), 'const c = 4;\n');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('coding worker edit transaction allows multiple edits targeting the same file', async () => {
  const workspaceRoot = createTempWorkspace();

  try {
    const sandbox = await createFlueLocalCodingSandbox({
      workspaceRoot,
      targetKind: 'workspace',
    });
    writeFileSync(join(workspaceRoot, 'a.js'), 'const a = 1;\nconst b = 2;\n');

    const transaction = createCodingEditTransaction('tx-same-file', [
      { path: 'a.js', oldText: 'const a = 1;', newText: 'const a = 10;', expectedOccurrences: 1 },
      { path: 'a.js', oldText: 'const b = 2;', newText: 'const b = 20;', expectedOccurrences: 1 },
    ], []);

    const result = await applyCodingEditTransaction(sandbox, transaction);

    assert.equal(result.status, 'applied');
    assert.equal(result.results.length, 2);
    assert.equal(result.results.every((r) => r.status === 'applied'), true);
    assert.equal(readFileSync(join(workspaceRoot, 'a.js'), 'utf8'), 'const a = 10;\nconst b = 20;\n');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('coding worker edit transaction rolls back all changes on first application failure', async () => {
  const workspaceRoot = createTempWorkspace();

  try {
    const sandbox = await createFlueLocalCodingSandbox({
      workspaceRoot,
      targetKind: 'workspace',
    });
    writeFileSync(join(workspaceRoot, 'a.js'), 'const a = 1;\n');

    const transaction = createCodingEditTransaction('tx-rollback', [], [
      // a.js is a regular file, so writing through it as a directory fails during application.
      { path: 'c.js', content: 'const c = 4;\n' },
      { path: 'a.js/b.js', content: 'const b = 3;\n' },
    ]);

    const result = await applyCodingEditTransaction(sandbox, transaction);

    assert.equal(result.status, 'failed');
    assert.ok(result.failure);
    assert.equal(result.failure?.path, 'a.js/b.js');
    assert.equal(result.failure?.operation, 'write');
    assert.match(result.failure?.reason ?? '', /EEXIST|ENOTDIR|not a directory|file already exists/i);

    // c.js was created and then deleted during rollback.
    assert.equal(existsSync(join(workspaceRoot, 'c.js')), false);
    // a.js is unchanged because the patch step never ran.
    assert.equal(readFileSync(join(workspaceRoot, 'a.js'), 'utf8'), 'const a = 1;\n');

    const cResult = result.results.find((r) => r.path === 'c.js');
    assert.equal(cResult?.status, 'rolled_back');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('coding worker edit transaction remains atomic when pre-flight validation fails', async () => {
  const workspaceRoot = createTempWorkspace();

  try {
    const sandbox = await createFlueLocalCodingSandbox({
      workspaceRoot,
      targetKind: 'workspace',
    });
    writeFileSync(join(workspaceRoot, 'a.js'), 'const a = 1;\n');

    const transaction = createCodingEditTransaction('tx-atomic', [
      { path: 'a.js', oldText: 'const a = 1;', newText: 'const a = 2;', expectedOccurrences: 1 },
      { path: 'missing.js', oldText: 'old', newText: 'new', expectedOccurrences: 1 },
    ], []);

    const result = await applyCodingEditTransaction(sandbox, transaction);

    assert.equal(result.status, 'failed');
    assert.equal(result.failure?.path, 'missing.js');
    // No files should have been mutated because validation runs before any write.
    assert.equal(readFileSync(join(workspaceRoot, 'a.js'), 'utf8'), 'const a = 1;\n');
    assert.equal(result.results.length, 0);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('coding worker edit transaction rejects binary patch targets', async () => {
  const workspaceRoot = createTempWorkspace();

  try {
    const sandbox = await createFlueLocalCodingSandbox({
      workspaceRoot,
      targetKind: 'workspace',
    });
    writeFileSync(join(workspaceRoot, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02]));

    const transaction = createCodingEditTransaction('tx-binary', [
      { path: 'binary.bin', oldText: '\x00', newText: 'x', expectedOccurrences: 1 },
    ], []);

    const result = await applyCodingEditTransaction(sandbox, transaction);

    assert.equal(result.status, 'failed');
    assert.equal(result.failure?.path, 'binary.bin');
    assert.match(result.failure?.reason ?? '', /binary file/);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('coding worker edit transaction rejects patches to missing files', async () => {
  const workspaceRoot = createTempWorkspace();

  try {
    const sandbox = await createFlueLocalCodingSandbox({
      workspaceRoot,
      targetKind: 'workspace',
    });

    const transaction = createCodingEditTransaction('tx-missing', [
      { path: 'missing.js', oldText: 'old', newText: 'new', expectedOccurrences: 1 },
    ], []);

    const result = await applyCodingEditTransaction(sandbox, transaction);

    assert.equal(result.status, 'failed');
    assert.equal(result.failure?.path, 'missing.js');
    assert.match(result.failure?.reason ?? '', /does not exist/);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('coding worker edit transaction tool applies and rolls back through the repo tools surface', async () => {
  const workspaceRoot = createTempWorkspace();

  try {
    writeFileSync(join(workspaceRoot, 'x.js'), 'const x = 1;\n');
    writeFileSync(join(workspaceRoot, 'y.js'), 'const y = 2;\n');

    const tools = createCodingRepoTools({ workspaceRoot, targetKind: 'workspace' });
    const applyTransaction = getTool(tools, 'coding_repo_apply_transaction');

    const success = JSON.parse(
      await applyTransaction.execute({
        id: 'tool-tx',
        edits: [
          { path: 'x.js', oldText: 'const x = 1;', newText: 'const x = 2;', expectedOccurrences: 1 },
        ],
        writes: [{ path: 'z.js', content: 'const z = 3;\n' }],
      }),
    ) as { status?: string; results?: Array<{ path: string; status: string }>; failure?: { path: string } };

    assert.equal(success.status, 'applied');
    assert.equal(readFileSync(join(workspaceRoot, 'x.js'), 'utf8'), 'const x = 2;\n');
    assert.equal(readFileSync(join(workspaceRoot, 'z.js'), 'utf8'), 'const z = 3;\n');

    const fail = JSON.parse(
      await applyTransaction.execute({
        id: 'tool-tx-fail',
        edits: [
          { path: 'x.js', oldText: 'const x = 1;', newText: 'const x = 9;', expectedOccurrences: 1 },
          { path: 'y.js', oldText: 'const y = 2;', newText: 'const y = 9;', expectedOccurrences: 1 },
        ],
        writes: [{ path: 'w.js', content: 'const w = 4;\n' }],
      }),
    ) as { status?: string; failure?: { path: string; reason: string } };

    assert.equal(fail.status, 'failed');
    assert.equal(fail.failure?.path, 'x.js');
    assert.match(fail.failure?.reason ?? '', /oldText was not found/);
    assert.equal(readFileSync(join(workspaceRoot, 'x.js'), 'utf8'), 'const x = 2;\n');
    assert.equal(readFileSync(join(workspaceRoot, 'y.js'), 'utf8'), 'const y = 2;\n');
    assert.equal(existsSync(join(workspaceRoot, 'w.js')), false);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('repo workflow tools gate branch creation through approval service', async () => {
  const project = createGitWorkspaceProject();
  const approvalService = createInMemoryCodingApprovalService();

  try {
    const branchTool = getTool(
      createCodingRepoWorkflowTools({
        workspaceRoot: project.workspaceRoot,
        targetKind: 'project',
        projectRelativePath: project.projectRelativePath,
        approvalService,
      }),
      'coding_repo_branch_create',
    );

    const blocked = JSON.parse(
      await branchTool.execute({
        taskId: 'task-branch',
        branch: 'feature-runtime',
      }),
    ) as { blocked?: boolean; request?: { id: string } };
    assert.equal(blocked.blocked, true);
    assert.ok(blocked.request?.id);

    await approvalService.recordDecision({
      requestId: blocked.request.id,
      approved: true,
      decidedBy: 'operator',
      principal: { id: 'operator', roles: ['operator'] },
    });
    const created = JSON.parse(
      await branchTool.execute({
        taskId: 'task-branch',
        branch: 'feature-runtime',
      }),
    ) as { status?: string };
    assert.equal(created.status, 'created');

    const branches = execFileSync('git', ['branch', '--list', 'feature-runtime'], {
      cwd: project.repoPath,
      encoding: 'utf8',
    });
    assert.match(branches, /feature-runtime/);
  } finally {
    rmSync(project.workspaceRoot, { recursive: true, force: true });
  }
});

test('repo workflow tools clone, register, and discover workspace repositories through approval service', async () => {
  const source = createGitWorkspaceProject();
  const workspaceRoot = createTempWorkspace();
  const approvalService = createInMemoryCodingApprovalService();
  const repoRegistry = new InMemoryCodingRepoRegistry();

  try {
    const tools = createCodingRepoWorkflowTools({
      workspaceRoot,
      targetKind: 'workspace',
      approvalService,
      repoRegistry,
    });
    const clone = getTool(tools, 'coding_repo_clone');
    const blockedClone = JSON.parse(
      await clone.execute({
        taskId: 'task-clone',
        remoteUrl: source.repoPath,
        slug: 'cloned-repo',
      }),
    ) as { blocked?: boolean; request?: { id: string } };
    assert.equal(blockedClone.blocked, true);
    assert.ok(blockedClone.request?.id);

    await approvalService.recordDecision({
      requestId: blockedClone.request.id,
      approved: true,
      decidedBy: 'operator',
      principal: { id: 'operator', roles: ['operator'] },
    });
    const cloned = JSON.parse(
      await clone.execute({
        taskId: 'task-clone',
        remoteUrl: source.repoPath,
        slug: 'cloned-repo',
      }),
    ) as { status?: string; repo?: { repoRelativePath?: string } };
    assert.equal(cloned.status, 'cloned');
    assert.equal(cloned.repo?.repoRelativePath, 'repos/cloned-repo');
    assert.equal(existsSync(join(workspaceRoot, 'repos', 'cloned-repo', '.git')), true);

    const register = getTool(tools, 'coding_repo_register');
    const blockedRegister = JSON.parse(
      await register.execute({
        taskId: 'task-register',
        slug: 'cloned-alias',
        repoRelativePath: 'repos/cloned-repo',
        remoteUrl: source.repoPath,
      }),
    ) as { blocked?: boolean; request?: { id: string } };
    assert.equal(blockedRegister.blocked, true);
    assert.ok(blockedRegister.request?.id);

    await approvalService.recordDecision({
      requestId: blockedRegister.request.id,
      approved: true,
      decidedBy: 'operator',
      principal: { id: 'operator', roles: ['operator'] },
    });
    const registered = JSON.parse(
      await register.execute({
        taskId: 'task-register',
        slug: 'cloned-alias',
        repoRelativePath: 'repos/cloned-repo',
        remoteUrl: source.repoPath,
      }),
    ) as { status?: string; repo?: { slug?: string } };
    assert.equal(registered.status, 'registered');
    assert.equal(registered.repo?.slug, 'cloned-alias');

    const discover = getTool(tools, 'coding_repo_discover');
    const discovered = JSON.parse(await discover.execute({})) as {
      registered?: Array<{ slug: string }>;
      discovered?: Array<{ repoRelativePath: string }>;
    };
    assert.equal(discovered.registered?.some((repo) => repo.slug === 'cloned-alias'), true);
    assert.equal(
      discovered.discovered?.some((repo) => repo.repoRelativePath === 'repos/cloned-repo'),
      true,
    );
  } finally {
    rmSync(source.workspaceRoot, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('orchestrator exposes repo execution only through the coding-worker lead', async () => {
  const project = createExecutableWorkspaceProject();

  try {
    const config = await orchestratorAgent.initialize({
      id: 'coding-worker-orchestrator-surface',
      env: {
        ...createModelEnv(),
        GOROMBO_WORKSPACE_ROOT: project.workspaceRoot,
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
      path: `${project.projectRelativePath}/index.js`,
      edits: [{ oldText: 'return 41;', newText: 'return 42;', expectedOccurrences: 1 }],
    });
    const output = JSON.parse(
      await shell.execute({ command: 'node test.js', cwd: project.projectRelativePath }),
    ) as { exitCode: number };

    assert.equal(output.exitCode, 0);
  } finally {
    rmSync(project.workspaceRoot, { recursive: true, force: true });
  }
});

test('coding worker workspace scope can edit workspace files and reject path escapes', async () => {
  const workspaceRoot = createTempWorkspace();

  try {
    writeFileSync(join(workspaceRoot, 'USER.md'), 'Principal: orchestrator\n');
    const tools = createCodingRepoTools({ workspaceRoot, targetKind: 'workspace' });
    const patch = getTool(tools, 'coding_repo_apply_patch');
    const read = getTool(tools, 'coding_repo_read_file');

    await patch.execute({
      path: 'USER.md',
      edits: [
        {
          oldText: 'Principal: orchestrator',
          newText: 'Principal: main orchestrator agent',
          expectedOccurrences: 1,
        },
      ],
    });

    const output = JSON.parse(await read.execute({ path: 'USER.md' })) as { content: string };
    assert.match(output.content, /main orchestrator agent/);
    await assert.rejects(() => read.execute({ path: '../outside.txt' }), /escapes coding-worker/);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('coding worker execFile only exposes baseline and approved environment variables', async () => {
  const project = createWorkspaceProject();
  const previousSecret = process.env.CODING_WORKER_SECRET_LEAK;
  process.env.CODING_WORKER_SECRET_LEAK = 'host-secret';

  try {
    const sandbox = await createFlueLocalCodingSandbox({
      workspaceRoot: project.workspaceRoot,
      targetKind: 'project',
      projectRelativePath: project.projectRelativePath,
      env: {
        CODING_WORKER_APPROVED_BASE: 'base-value',
      },
    });
    const output = await sandbox.execFile(
      process.execPath,
      [
        '-e',
        [
          'console.log(JSON.stringify({',
          'secret: process.env.CODING_WORKER_SECRET_LEAK ?? null,',
          'base: process.env.CODING_WORKER_APPROVED_BASE ?? null,',
          'override: process.env.CODING_WORKER_APPROVED_OVERRIDE ?? null,',
          'hasPath: typeof process.env.PATH === "string" && process.env.PATH.length > 0',
          '}));',
        ].join(''),
      ],
      {
        env: {
          CODING_WORKER_APPROVED_OVERRIDE: 'override-value',
        },
      },
    );
    const env = JSON.parse(output.stdout) as {
      secret: string | null;
      base: string | null;
      override: string | null;
      hasPath: boolean;
    };

    assert.equal(output.exitCode, 0);
    assert.equal(env.secret, null);
    assert.equal(env.base, 'base-value');
    assert.equal(env.override, 'override-value');
    assert.equal(env.hasPath, true);
  } finally {
    if (previousSecret === undefined) {
      delete process.env.CODING_WORKER_SECRET_LEAK;
    } else {
      process.env.CODING_WORKER_SECRET_LEAK = previousSecret;
    }
    rmSync(project.workspaceRoot, { recursive: true, force: true });
  }
});

test('coding worker shell tool blocks git and GitHub writes without approval', async () => {
  const project = createExecutableWorkspaceProject();

  try {
    const shell = getTool(
      createCodingRepoTools({
        workspaceRoot: project.workspaceRoot,
        targetKind: 'project',
        projectRelativePath: project.projectRelativePath,
      }),
      'coding_shell_run',
    );
    const output = JSON.parse(await shell.execute({ command: 'git -C . push origin main' })) as {
      blocked?: boolean;
      approvalAction?: string;
    };
    const ghOutput = JSON.parse(await shell.execute({ command: 'gh api repos/example/example -XPOST' })) as {
      blocked?: boolean;
      approvalAction?: string;
    };

    assert.equal(output.blocked, true);
    assert.equal(output.approvalAction, 'git.write');
    assert.equal(ghOutput.blocked, true);
    assert.equal(ghOutput.approvalAction, 'github.write');
  } finally {
    rmSync(project.workspaceRoot, { recursive: true, force: true });
  }
});

test('coding worker git commit tool requires approval and commits when approved', async () => {
  const project = createGitWorkspaceProject();

  try {
    writeFileSync(join(project.repoPath, 'index.js'), 'exports.answer = function answer() { return 42; };\n');
    const commit = getTool(
      createCodingGitTools({
        workspaceRoot: project.workspaceRoot,
        targetKind: 'project',
        projectRelativePath: project.projectRelativePath,
      }),
      'coding_git_commit',
    );

    const blocked = JSON.parse(
      await commit.execute({
        taskId: 'task-commit',
        message: 'Update answer',
        paths: ['index.js'],
        approved: true,
      }),
    ) as { blocked?: boolean };
    assert.equal(blocked.blocked, true);

    const approvalService = createInMemoryCodingApprovalService();
    const injectedMessage = 'Update answer $(node -e "require(\'fs\').writeFileSync(\'pwned.txt\',\'x\')")';
    const approvalRequest = await approvalService.createRequest({
      taskId: 'task-commit',
      actionType: 'git.commit',
      summary: `Commit local changes: ${injectedMessage}`,
      reason: 'Committing records local repository state.',
      risk: 'This mutates git history in the local branch.',
      target: 'index.js',
    });
    await approvalService.recordDecision({
      requestId: approvalRequest.id,
      approved: true,
      decidedBy: 'test',
      principal: { id: 'test', roles: ['operator'] },
    });

    const approvedCommit = getTool(
      createCodingGitTools({
        workspaceRoot: project.workspaceRoot,
        targetKind: 'project',
        projectRelativePath: project.projectRelativePath,
        approvalService,
      }),
      'coding_git_commit',
    );
    const output = JSON.parse(
      await approvedCommit.execute({
        taskId: 'task-commit',
        message: injectedMessage,
        paths: ['index.js'],
      }),
    ) as { status?: string };
    assert.equal(output.status, 'committed');
    assert.equal(existsSync(join(project.repoPath, 'pwned.txt')), false);

    const log = execFileSync('git', ['log', '--oneline', '-1'], { cwd: project.repoPath, encoding: 'utf8' });
    assert.match(log, /Update answer/);
  } finally {
    rmSync(project.workspaceRoot, { recursive: true, force: true });
  }
});

test('coding worker GitHub PR creation tool is approval-gated', async () => {
  const project = createGitWorkspaceProject();

  try {
    const createPr = getTool(
      createCodingGitTools({
        workspaceRoot: project.workspaceRoot,
        targetKind: 'project',
        projectRelativePath: project.projectRelativePath,
      }),
      'coding_github_create_pr',
    );
    const output = JSON.parse(
      await createPr.execute({
        taskId: 'task-pr',
        title: 'Test PR',
        body: 'Test body',
      }),
    ) as {
      actions: Array<{
        action: string;
        payload: { blocked?: boolean };
      }>;
    };

    assert.equal(output.actions[0]?.action, 'create_pr');
    assert.equal(output.actions[0]?.payload.blocked, true);
  } finally {
    rmSync(project.workspaceRoot, { recursive: true, force: true });
  }
});

test('coding worker loop emits completion telemetry for blocked verification commands', async () => {
  const project = createExecutableWorkspaceProject();
  const reporter = new InMemoryCodingProgressReporter();
  const approvalService = createAutoApprovingApprovalService(['file.edit']);

  try {
    const result = await runCodingWorkerLoop(
      {
        taskId: 'task-blocked-verification',
        text: 'Run blocked verification.',
        workspaceRoot: project.workspaceRoot,
        targetKind: 'project',
        projectRelativePath: project.projectRelativePath,
        verificationCommands: [
          {
            name: 'blocked-git-write',
            command: 'git push origin main',
            required: true,
            reason: 'Git writes must be approval gated.',
          },
        ],
      },
      { reporter, approvalService, delegate: createFakeDelegate() },
    );

    const events = reporter.events();
    assert.equal(result.status, 'blocked');
    assert.equal(events.filter((event) => event.type === 'coding.verification.started').length, 1);
    assert.equal(events.filter((event) => event.type === 'coding.verification.completed').length, 1);
    assert.equal(
      result.verification.evidence[0]?.summary,
      'Git write commands must use the coding-worker approval-gated git/GitHub path.',
    );
  } finally {
    rmSync(project.workspaceRoot, { recursive: true, force: true });
  }
});

test('coding worker loop emits public progress and blocks completion without verification evidence', async () => {
  const project = createExecutableWorkspaceProject();
  const reporter = new InMemoryCodingProgressReporter();
  const approvalService = createAutoApprovingApprovalService(['file.edit']);

  try {
    const result = await runCodingWorkerLoop(
      {
        taskId: 'task-no-verification',
        text: 'Implement a feature',
        workspaceRoot: project.workspaceRoot,
        targetKind: 'project',
        projectRelativePath: project.projectRelativePath,
      },
      {
        reporter,
        approvalService,
        delegate: createFakeDelegate(),
        preflight: () => ({
          repoPath: project.repoPath,
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
  } finally {
    rmSync(project.workspaceRoot, { recursive: true, force: true });
  }
});

test('coding worker loop edits a temp repo and completes only after verification passes', async () => {
  const project = createExecutableWorkspaceProject();
  const approvalService = createAutoApprovingApprovalService(['file.edit']);

  try {
    const taskRunStore = JsonFileCodingTaskRunStore.atWorkspaceRoot(project.workspaceRoot);
    const result = await runCodingWorkerLoop({
      taskId: 'task-with-real-edit',
      text: 'Fix answer implementation.',
      workspaceRoot: project.workspaceRoot,
      targetKind: 'project',
      projectRelativePath: project.projectRelativePath,
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
    }, { taskRunStore, approvalService, delegate: createFakeDelegate() });

    assert.equal(result.status, 'completed');
    assert.match(readFileSync(join(project.repoPath, 'index.js'), 'utf8'), /return 42/);
    assert.equal(result.subagentResults.some((item) => item.subagent === 'implementer'), true);
    assert.equal(result.publicEvents.some((event) => JSON.stringify(event).includes('coding.verification.completed')), true);
    assert.doesNotThrow(() => assertCodingWorkerCanComplete(result));
    const stored = await taskRunStore.get('task-with-real-edit');
    assert.equal(stored?.status, 'completed');
    assert.equal(stored?.checkpoint?.currentStep, 'completed');
    assert.equal(stored?.sessionPlan.childSessions.implementer.includes(':implementer'), true);
    assert.equal(stored?.events.some((event) => event.type === 'coding.completed'), true);
  } finally {
    rmSync(project.workspaceRoot, { recursive: true, force: true });
  }
});

test('coding worker loop debug loop patches after a failed verification run', async () => {
  const project = createExecutableWorkspaceProject();
  const approvalService = createAutoApprovingApprovalService(['file.edit']);

  try {
    const result = await runCodingWorkerLoop({
      taskId: 'task-debug-loop',
      text: 'Fix answer implementation through debug loop.',
      workspaceRoot: project.workspaceRoot,
      targetKind: 'project',
      projectRelativePath: project.projectRelativePath,
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
    }, { approvalService, delegate: createFakeDelegate() });

    assert.equal(result.status, 'completed');
    assert.match(readFileSync(join(project.repoPath, 'index.js'), 'utf8'), /return 42/);
    assert.equal(result.verification.evidence.some((item) => item.status === 'failed'), true);
    assert.equal(result.verification.evidence.some((item) => item.status === 'passed'), true);
  } finally {
    rmSync(project.workspaceRoot, { recursive: true, force: true });
  }
});

test('coding worker loop can complete with passing required verification evidence', async () => {
  const project = createExecutableWorkspaceProject();
  const approvalService = createAutoApprovingApprovalService(['file.edit']);

  try {
  const result = await runCodingWorkerLoop(
    {
      taskId: 'task-with-verification',
      text: 'Implement a feature',
      workspaceRoot: project.workspaceRoot,
      targetKind: 'project',
      projectRelativePath: project.projectRelativePath,
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
      approvalService,
      delegate: createFakeDelegate(),
      preflight: () => ({
        repoPath: project.repoPath,
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
    rmSync(project.workspaceRoot, { recursive: true, force: true });
  }
});

test('coding implementer submit result validates and emits a CodingImplementerResult', async () => {
  const tools = createCodingImplementerTools();
  const submit = getTool(tools, 'coding_implementer_submit_result');

  const result = JSON.parse(
    await submit.execute({
      fileEdits: [{ path: 'index.js', oldText: 'return 41;', newText: 'return 42;', expectedOccurrences: 1 }],
      writeFiles: [{ path: 'new.js', content: 'console.log("ok");\n' }],
      verificationCommands: [{ name: 'unit', command: 'node test.js', required: true, reason: 'verify' }],
    }),
  ) as { status?: string; result?: unknown };

  assert.equal(result.status, 'submitted');
  const parsedResult = v.parse(CodingImplementerResultSchema, result.result);
  assert.equal(parsedResult.fileEdits.length, 1);
  assert.equal(parsedResult.fileEdits[0].path, 'index.js');
  assert.equal(parsedResult.fileEdits[0].oldText, 'return 41;');
  assert.equal(parsedResult.fileEdits[0].newText, 'return 42;');
  assert.equal(parsedResult.fileEdits[0].expectedOccurrences, 1);
  assert.equal(parsedResult.writeFiles.length, 1);
  assert.equal(parsedResult.writeFiles[0].path, 'new.js');
  assert.equal(parsedResult.verificationCommands.length, 1);
  assert.equal(parsedResult.verificationCommands[0].name, 'unit');

  await assert.rejects(
    () =>
      submit.execute({
        fileEdits: [{ path: 123, oldText: 'a', newText: 'b' }],
        writeFiles: [],
        verificationCommands: [],
      } as never),
    /Invalid/,
  );
});

test('coding repo apply patch produces valid CodingFileEdit objects', async () => {
  const project = createExecutableWorkspaceProject();

  try {
    const tools = createCodingRepoTools({
      workspaceRoot: project.workspaceRoot,
      targetKind: 'project',
      projectRelativePath: project.projectRelativePath,
    });
    const patch = getTool(tools, 'coding_repo_apply_patch');

    const result = JSON.parse(
      await patch.execute({
        path: 'index.js',
        edits: [{ oldText: 'return 41;', newText: 'return 42;', expectedOccurrences: 1 }],
      }),
    ) as { status?: string; replacements?: number; edits?: unknown[] };

    assert.equal(result.status, 'patched');
    assert.equal(result.replacements, 1);
    assert.equal(Array.isArray(result.edits), true);
    assert.equal(result.edits?.length, 1);

    const edit = v.parse(CodingFileEditSchema, result.edits?.[0]);
    assert.equal(edit.path, 'index.js');
    assert.equal(edit.oldText, 'return 41;');
    assert.equal(edit.newText, 'return 42;');
    assert.equal(edit.expectedOccurrences, 1);
  } finally {
    rmSync(project.workspaceRoot, { recursive: true, force: true });
  }
});

test('coding repo apply exact edit works and returns a valid CodingFileEdit', async () => {
  const project = createExecutableWorkspaceProject();

  try {
    const tools = createCodingRepoTools({
      workspaceRoot: project.workspaceRoot,
      targetKind: 'project',
      projectRelativePath: project.projectRelativePath,
    });
    const exactEdit = getTool(tools, 'coding_repo_apply_exact_edit');

    const result = JSON.parse(
      await exactEdit.execute({
        path: 'index.js',
        oldText: 'return 41;',
        newText: 'return 42;',
        expectedOccurrences: 1,
      }),
    ) as { status?: string; replacements?: number; edit?: unknown };

    assert.equal(result.status, 'patched');
    assert.equal(result.replacements, 1);

    const edit = v.parse(CodingFileEditSchema, result.edit);
    assert.equal(edit.path, 'index.js');
    assert.equal(edit.oldText, 'return 41;');
    assert.equal(edit.newText, 'return 42;');
    assert.equal(edit.expectedOccurrences, 1);
  } finally {
    rmSync(project.workspaceRoot, { recursive: true, force: true });
  }
});

test('coding worker lead loop applies implementer structured edits and completes', async () => {
  const project = createExecutableWorkspaceProject();
  const approvalService = createAutoApprovingApprovalService(['file.edit']);

  try {
    const result = await runCodingWorkerLoop(
      {
        taskId: 'task-implementer-structured',
        text: 'Fix answer implementation.',
        workspaceRoot: project.workspaceRoot,
        targetKind: 'project',
        projectRelativePath: project.projectRelativePath,
        verificationCommands: [
          {
            name: 'unit',
            command: 'node test.js',
            required: true,
            reason: 'Temp repo unit verification must pass.',
          },
        ],
      },
      {
        approvalService,
        delegate: createFakeDelegate({
          implementer: {
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
          },
        }),
      },
    );

    assert.equal(result.status, 'completed');
    assert.match(readFileSync(join(project.repoPath, 'index.js'), 'utf8'), /return 42/);
    assert.equal(result.subagentResults.some((item) => item.subagent === 'implementer'), true);
    assert.doesNotThrow(() => assertCodingWorkerCanComplete(result));
  } finally {
    rmSync(project.workspaceRoot, { recursive: true, force: true });
  }
});

interface TempWorkspaceProject {
  workspaceRoot: string;
  projectRelativePath: string;
  repoPath: string;
}

function createTempWorkspace() {
  return mkdtempSync(join(tmpdir(), 'coding-worker-workspace-'));
}

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

function createWorkspaceProject(projectRelativePath = 'projects/answer-app'): TempWorkspaceProject {
  const workspaceRoot = createTempWorkspace();
  const repoPath = join(workspaceRoot, ...projectRelativePath.split('/'));
  mkdirSync(repoPath, { recursive: true });
  return {
    workspaceRoot,
    projectRelativePath,
    repoPath,
  };
}

function createExecutableWorkspaceProject(): TempWorkspaceProject {
  const project = createWorkspaceProject();
  writeExecutableProjectFiles(project.repoPath);
  return project;
}

function writeExecutableProjectFiles(repoPath: string): void {
  writeFileSync(
    join(repoPath, 'package.json'),
    JSON.stringify(
      {
        scripts: {
          test: 'node test.js',
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(repoPath, 'index.js'), 'exports.answer = function answer() { return 41; };\n');
  writeFileSync(
    join(repoPath, 'test.js'),
    "const { answer } = require('./index.js');\nif (answer() !== 42) {\n  console.error(`expected 42, got ${answer()}`);\n  process.exit(1);\n}\n",
  );
}

function createGitWorkspaceProject(): TempWorkspaceProject {
  const project = createExecutableWorkspaceProject();
  execFileSync('git', ['init'], { cwd: project.repoPath });
  execFileSync('git', ['config', 'user.email', 'coding-worker@example.test'], { cwd: project.repoPath });
  execFileSync('git', ['config', 'user.name', 'Coding Worker Test'], { cwd: project.repoPath });
  execFileSync('git', ['add', '.'], { cwd: project.repoPath });
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: project.repoPath });
  return project;
}

test('coding worker loop state initializes with bounded turn guard and checkpoint shape', () => {
  const project = createExecutableWorkspaceProject();

  try {
    const sessionPlan = createCodingWorkerSessionPlan('task-state', 'state-session');
    const preflight = runCodingRepoPreflight(project.repoPath);
    const state = createInitialLoopState(
      {
        taskId: 'task-state',
        text: 'Fix bug.',
        workspaceRoot: project.workspaceRoot,
        targetKind: 'project',
        projectRelativePath: project.projectRelativePath,
        maxTurns: 7,
      },
      sessionPlan,
      preflight,
      7,
    );

    assert.equal(state.currentStep, 'triage');
    assert.equal(state.turn, 0);
    assert.equal(state.maxTurns, 7);
    assert.equal(state.replanCount, 0);
    assert.equal(state.sessionPlan.leadSessionName, sessionPlan.leadSessionName);
    assert.equal(state.preflight.repoPath, project.repoPath);

    const checkpoint = createLoopCheckpoint(state);
    assert.equal(checkpoint.taskId, 'task-state');
    assert.equal(checkpoint.currentStep, 'triage');
    assert.equal(checkpoint.turn, 0);
    assert.equal(checkpoint.maxTurns, 7);
    assert.equal(checkpoint.plan.length, 4);
    assert.equal(checkpoint.pendingEdits.fileEdits.length, 0);
    assert.equal(checkpoint.pendingEdits.writeFiles.length, 0);
    assert.equal(checkpoint.verificationResults.requiredCommands.length, preflight.verificationPlan.length);
  } finally {
    rmSync(project.workspaceRoot, { recursive: true, force: true });
  }
});

test('coding worker loop persists a checkpoint after each turn', async () => {
  const project = createExecutableWorkspaceProject();
  const reporter = new InMemoryCodingProgressReporter();
  const taskRunStore = new JsonFileCodingTaskRunStore(join(project.workspaceRoot, 'task-runs.json'));
  const approvalService = createAutoApprovingApprovalService(['file.edit']);

  try {
    const result = await runCodingWorkerLoop(
      {
        taskId: 'task-checkpoint',
        text: 'Fix answer implementation.',
        workspaceRoot: project.workspaceRoot,
        targetKind: 'project',
        projectRelativePath: project.projectRelativePath,
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
      },
      { reporter, taskRunStore, approvalService, delegate: createFakeDelegate() },
    );

    assert.equal(result.status, 'completed');
    const stored = await taskRunStore.get('task-checkpoint');
    assert.ok(stored?.checkpoint);
    assert.equal(stored.checkpoint.status, 'completed');
    assert.equal(stored.checkpoint.currentStep, 'completed');
    assert.equal(stored.checkpoint.turn >= 1, true);
    assert.equal(stored.checkpoint.subagentHistory.length > 0, true);
  } finally {
    rmSync(project.workspaceRoot, { recursive: true, force: true });
  }
});

test('coding worker loop blocks when file edit approval is denied', async () => {
  const project = createExecutableWorkspaceProject();
  const reporter = new InMemoryCodingProgressReporter();
  const approvalService = createInMemoryCodingApprovalService();

  try {
    const result = await runCodingWorkerLoop(
      {
        taskId: 'task-edit-denied',
        text: 'Fix answer implementation.',
        workspaceRoot: project.workspaceRoot,
        targetKind: 'project',
        projectRelativePath: project.projectRelativePath,
        fileEdits: [
          {
            path: 'index.js',
            oldText: 'return 41;',
            newText: 'return 42;',
            expectedOccurrences: 1,
          },
        ],
      },
      { reporter, approvalService, delegate: createFakeDelegate() },
    );

    assert.equal(result.status, 'blocked');
    assert.equal(reporter.events().some((event) => event.type === 'coding.approval.requested'), true);
    assert.equal(readFileSync(join(project.repoPath, 'index.js'), 'utf8').includes('return 41'), true);
  } finally {
    rmSync(project.workspaceRoot, { recursive: true, force: true });
  }
});

test('coding worker loop replans when code review rejects', async () => {
  const project = createExecutableWorkspaceProject();
  const reporter = new InMemoryCodingProgressReporter();
  const approvalService = createAutoApprovingApprovalService(['file.edit']);
  let implementerCalls = 0;

  try {
    const result = await runCodingWorkerLoop(
      {
        taskId: 'task-review-reject',
        text: 'Fix answer implementation.',
        workspaceRoot: project.workspaceRoot,
        targetKind: 'project',
        projectRelativePath: project.projectRelativePath,
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
      },
      {
        reporter,
        approvalService,
        delegate: async (subagent, request) => {
          const base = await createFakeDelegate({
            implementer: {
              fileEdits: implementerCalls > 0 ? [] : request.task.fileEdits,
            },
            codeReview: {
              approved: implementerCalls > 1,
              findings: implementerCalls > 1 ? [] : [{ severity: 'blocker', message: 'Need a better fix.' }],
            },
          })(subagent, request);
          if (subagent === 'implementer') {
            implementerCalls += 1;
          }
          return base;
        },
      },
    );

    assert.equal(result.status, 'completed');
    assert.equal(implementerCalls, 2);
    assert.equal(reporter.events().some((event) => event.type === 'coding.replanned'), true);
    assert.equal((result.checkpoint?.replanCount ?? 0) >= 1, true);
  } finally {
    rmSync(project.workspaceRoot, { recursive: true, force: true });
  }
});

test('coding worker loop pauses when code review repeatedly rejects and replan budget is exhausted', async () => {
  const project = createExecutableWorkspaceProject();
  const reporter = new InMemoryCodingProgressReporter();
  const approvalService = createAutoApprovingApprovalService(['file.edit']);

  try {
    const result = await runCodingWorkerLoop(
      {
        taskId: 'task-review-reject-exhausted',
        text: 'Fix answer implementation.',
        workspaceRoot: project.workspaceRoot,
        targetKind: 'project',
        projectRelativePath: project.projectRelativePath,
        verificationCommands: [
          {
            name: 'unit',
            command: 'node -e "process.exit(0)"',
            required: true,
            reason: 'Synthetic verification must pass.',
          },
        ],
        maxTurns: 20,
      },
      {
        reporter,
        approvalService,
        maxReplans: 1,
        delegate: createFakeDelegate({
          implementer: { fileEdits: [] },
          codeReview: {
            approved: false,
            findings: [{ severity: 'blocker', message: 'Repeated rejection.' }],
          },
        }),
      },
    );

    assert.equal(result.status, 'blocked');
    assert.match(result.summary, /replan budget/);
    assert.equal(reporter.events().some((event) => event.type === 'coding.replanned'), true);
    assert.equal(reporter.events().some((event) => event.type === 'coding.blocked'), true);
    assert.ok(result.checkpoint);
    assert.equal((result.checkpoint?.replanCount ?? 0) >= 2, true);
  } finally {
    rmSync(project.workspaceRoot, { recursive: true, force: true });
  }
});

test('coding worker loop respects the max turn guard and returns blocked', async () => {
  const project = createExecutableWorkspaceProject();
  const reporter = new InMemoryCodingProgressReporter();
  const approvalService = createAutoApprovingApprovalService(['file.edit']);

  try {
    const result = await runCodingWorkerLoop(
      {
        taskId: 'task-max-turns',
        text: 'Fix answer implementation.',
        workspaceRoot: project.workspaceRoot,
        targetKind: 'project',
        projectRelativePath: project.projectRelativePath,
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
        maxTurns: 2,
      },
      { reporter, approvalService, delegate: createFakeDelegate() },
    );

    assert.equal(result.status, 'blocked');
    assert.match(result.summary, /Exceeded maximum loop turns/);
    assert.equal(result.checkpoint?.maxTurns, 2);
  } finally {
    rmSync(project.workspaceRoot, { recursive: true, force: true });
  }
});

test('coding worker end-to-end fixes bug, commits, pushes branch, and prepares a PR', async () => {
  const { project, remotePath } = createGitWorkspaceProjectWithRemote();
  const reporter = new InMemoryCodingProgressReporter();
  const approvalService = createAutoApprovingApprovalService([
    'file.edit',
    'git.commit',
    'git.push',
    'repo.branch.create',
    'github.pr.create',
  ]);
  const fakeClient = createFakeGitHubClient();
  const sandbox = await createFlueLocalCodingSandbox({
    workspaceRoot: project.workspaceRoot,
    targetKind: 'project',
    projectRelativePath: project.projectRelativePath,
    sessionId: 'task-e2e-fix-and-pr',
  });

  try {
    const result = await runCodingWorkerLoop(
      {
        taskId: 'task-e2e-fix-and-pr',
        text: 'Fix the off-by-one bug in index.js and open a PR.',
        workspaceRoot: project.workspaceRoot,
        targetKind: 'project',
        projectRelativePath: project.projectRelativePath,
        github: { owner: 'dansasser', repo: 'astro-flue-agent', issueNumber: 7 },
        verificationCommands: [
          {
            name: 'unit',
            command: 'node test.js',
            required: true,
            reason: 'Unit test must pass after the off-by-one fix.',
          },
        ],
        maxTurns: 10,
      },
      {
        reporter,
        approvalService,
        sandbox,
        delegate: createEndToEndDelegate({ approvalService, fakeClient, project, sandbox }),
      },
    );

    assert.equal(result.status, 'completed');
    assert.doesNotThrow(() => assertCodingWorkerCanComplete(result));
    assert.ok(result.checkpoint);
    assert.equal(result.checkpoint.turn <= result.checkpoint.maxTurns, true);

    // The implementer edit fixed the bug.
    assert.match(readFileSync(join(project.repoPath, 'index.js'), 'utf8'), /return 42/);

    // Verification passed.
    assert.equal(result.verification.evidence.some((item) => item.command === 'node test.js' && item.status === 'passed'), true);

    // An approval-gated commit was created in the temp repo.
    const log = execFileSync('git', ['log', '--oneline', '-1'], { cwd: project.repoPath, encoding: 'utf8' });
    assert.match(log, /Fix off-by-one bug/);

    // The feature branch was pushed to the local bare remote.
    const remoteBranches = execFileSync('git', ['ls-remote', '--heads', remotePath], {
      cwd: project.repoPath,
      encoding: 'utf8',
    });
    assert.match(remoteBranches, /refs\/heads\/feature\/fix-off-by-one/);

    // The GitHub subagent produced a create_pr action and surfaced evidence.
    const githubResult = result.subagentResults.find((item) => item.subagent === 'github');
    assert.ok(githubResult);
    assert.equal(githubResult.structuredOutput?.type, 'github');
    const createPrAction = githubResult.structuredOutput?.result.actions.find(
      (action) => action.action === 'create_pr',
    );
    assert.ok(createPrAction);
    assert.equal(createPrAction.payload.head, 'feature/fix-off-by-one');
    assert.equal(createPrAction.payload.base, 'main');

    // Public progress events cover every major checkpoint.
    const events = reporter.events();
    assert.equal(events.some((event) => event.type === 'coding.triage.completed'), true);
    assert.equal(events.some((event) => event.type === 'coding.implementer.completed'), true);
    assert.equal(events.some((event) => event.type === 'coding.test-debug.completed'), true);
    assert.equal(events.some((event) => event.type === 'coding.review.completed'), true);
    assert.equal(events.some((event) => event.type === 'coding.github.completed'), true);
    assert.equal(events.some((event) => event.type === 'coding.completed'), true);
  } finally {
    rmSync(project.workspaceRoot, { recursive: true, force: true });
    rmSync(remotePath, { recursive: true, force: true });
  }
});

function createGitWorkspaceProjectWithRemote(): { project: TempWorkspaceProject; remotePath: string } {
  const project = createGitWorkspaceProject();
  const remotePath = mkdtempSync(join(tmpdir(), 'coding-worker-remote-'));
  execFileSync('git', ['init', '--bare'], { cwd: remotePath });
  execFileSync('git', ['remote', 'add', 'origin', remotePath], { cwd: project.repoPath });
  return { project, remotePath };
}

function createFakeGitHubClient(): GitHubClient {
  return {
    async getIssue() {
      return { number: 7, title: 'Fix off-by-one bug', state: 'OPEN' };
    },
    async getPullRequest() {
      return {
        number: 13,
        title: 'Fix off-by-one bug in index.js',
        state: 'OPEN',
        baseRef: 'main',
        headRef: 'feature/fix-off-by-one',
      };
    },
    async listPullRequestChecks() {
      return [{ name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }];
    },
  };
}

interface EndToEndDelegateInput {
  approvalService: import('../workers/coding-worker/approvals/approval-service.js').CodingApprovalService;
  fakeClient: GitHubClient;
  project: TempWorkspaceProject;
  sandbox: import('../workers/coding-worker/tools/sandbox-runtime.js').CodingSandboxRuntime;
}

function createEndToEndDelegate(input: EndToEndDelegateInput): (
  subagent: CodingSubagentKind,
  request: CodingTaskSubagentRequest,
) => Promise<CodingSubagentRunResult> {
  const base = createFakeDelegate({
    triage: { recommendedExecutionPath: 'implementer' },
    implementer: {
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
          reason: 'Unit test must pass after the off-by-one fix.',
        },
      ],
    },
    testDebug: { debugEdits: [], verificationCommands: [] },
    codeReview: { approved: true, findings: [] },
  });

  return async (subagent, request) => {
    if (subagent !== 'github') {
      return base(subagent, request);
    }

    const branch = 'feature/fix-off-by-one';
    const message = 'Fix off-by-one bug in index.js';

    // Approval-gated branch creation.
    const workflowTools = createCodingRepoWorkflowTools({
      workspaceRoot: input.project.workspaceRoot,
      targetKind: 'project',
      projectRelativePath: input.project.projectRelativePath,
      approvalService: input.approvalService,
      sandbox: input.sandbox,
    });
    const branchTool = getTool(workflowTools, 'coding_repo_branch_create');
    const branchResult = JSON.parse(
      await branchTool.execute({
        taskId: request.task.taskId,
        branch,
        checkout: true,
      }),
    ) as { status?: string };
    assert.equal(branchResult.status, 'created');

    // Approval-gated commit.
    const gitTools = createCodingGitTools({
      workspaceRoot: input.project.workspaceRoot,
      targetKind: 'project',
      projectRelativePath: input.project.projectRelativePath,
      approvalService: input.approvalService,
      sandbox: input.sandbox,
    });
    const commitTool = getTool(gitTools, 'coding_git_commit');
    const commitResult = JSON.parse(
      await commitTool.execute({
        taskId: request.task.taskId,
        message,
        paths: ['index.js'],
      }),
    ) as { status?: string };
    assert.equal(commitResult.status, 'committed');
    assert.equal(
      execFileSync('git', ['branch', '--show-current'], { cwd: input.project.repoPath, encoding: 'utf8' }).trim(),
      branch,
    );

    // Approval-gated push to the local bare remote.
    const pushTool = getTool(gitTools, 'coding_git_push');
    const pushResult = JSON.parse(
      await pushTool.execute({
        taskId: request.task.taskId,
        remote: 'origin',
        branch,
      }),
    ) as { status?: string };
    assert.equal(pushResult.status, 'pushed');

    // Approval-gated PR preparation through the GitHub tools surface.
    const githubTools = createCodingGitHubTools({
      client: input.fakeClient,
      approvalService: input.approvalService,
    });
    const requestApproval = getTool(githubTools, 'coding_github_request_approval');
    const approvalResult = JSON.parse(
      await requestApproval.execute({
        taskId: request.task.taskId,
        actionType: 'github.pr.create',
        summary: 'Create PR for off-by-one fix',
        reason: 'Publish the fix for review.',
        risk: 'This opens remote PR state on GitHub.',
      }),
    ) as {
      actions: Array<{
        payload: {
          request: { id: string };
          evaluation: { allowed: boolean };
        };
      }>;
    };
    assert.equal(approvalResult.actions[0]?.payload.evaluation.allowed, true);

    return {
      subagent: 'github',
      summary: 'Created branch, committed, pushed, and prepared PR.',
      evidence: [branch, message, `approval:${approvalResult.actions[0]?.payload.request.id}`],
      structuredOutput: {
        type: 'github',
        result: {
          actions: [
            {
              action: 'create_pr',
              payload: {
                owner: 'dansasser',
                repo: 'astro-flue-agent',
                title: message,
                body: 'Fixes the off-by-one bug in index.js.',
                head: branch,
                base: 'main',
                status: 'prepared',
              },
            },
          ],
        },
      },
    };
  };
}

function createMinimalLoopState(
  taskId: string,
  plan: import('../workers/coding-worker/types.js').CodingPlanItem[],
): import('../workers/coding-worker/types.js').CodingWorkerLoopState {
  return {
    task: { taskId, text: 'test task' },
    sessionPlan: {
      taskId,
      leadSessionName: 'test-session',
      childSessions: {
        triage: 'test-session:triage',
        implementer: 'test-session:implementer',
        'test-debug': 'test-session:test-debug',
        'code-review': 'test-session:code-review',
        github: 'test-session:github',
      },
    },
    preflight: {
      repoPath: '',
      packageManager: 'pnpm',
      scripts: {},
      verificationPlan: [],
    },
    currentStep: 'triage',
    turn: 1,
    maxTurns: 10,
    plan,
    approvalQueue: [],
    pendingEdits: {
      fileEdits: [],
      writeFiles: [],
    },
    verificationResults: {
      requiredCommands: [],
      evidence: [],
    },
    subagentHistory: [],
    replanCount: 0,
  };
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
    GOROMBO_WORKSPACE_ROOT: process.cwd(),
  };
}

interface FakeDelegateOptions {
  triage?: Partial<import('../workers/coding-worker/types.js').CodingTriageResult>;
  implementer?: Partial<import('../workers/coding-worker/types.js').CodingImplementerResult>;
  testDebug?: Partial<import('../workers/coding-worker/types.js').CodingTestDebugResult>;
  codeReview?: Partial<import('../workers/coding-worker/types.js').CodingCodeReviewResult>;
  github?: Partial<import('../workers/coding-worker/types.js').CodingGithubResult>;
}

function createFakeDelegate(options: FakeDelegateOptions = {}): (
  subagent: CodingSubagentKind,
  request: CodingTaskSubagentRequest,
) => Promise<CodingSubagentRunResult> {
  return async (subagent, request) => {
    const base = {
      summary: `${subagent} result`,
      evidence: [subagent],
    };

    switch (subagent) {
      case 'triage': {
        const plan = options.triage?.plan ?? createInitialCodingPlan(request.task);
        const filesToInspect = options.triage?.filesToInspect ?? [];
        const recommendedExecutionPath = options.triage?.recommendedExecutionPath ?? 'implementer';
        return {
          subagent,
          ...base,
          structuredOutput: { type: 'triage', result: { plan, filesToInspect, recommendedExecutionPath } },
        };
      }
      case 'implementer': {
        const fileEdits = options.implementer?.fileEdits ?? request.task.fileEdits ?? [];
        const writeFiles = options.implementer?.writeFiles ?? request.task.writeFiles ?? [];
        const verificationCommands = options.implementer?.verificationCommands ?? request.task.verificationCommands ?? [];
        return {
          subagent,
          ...base,
          structuredOutput: { type: 'implementer', result: { fileEdits, writeFiles, verificationCommands } },
        };
      }
      case 'test-debug': {
        const debugEdits = options.testDebug?.debugEdits ?? request.task.debugEdits ?? [];
        const verificationCommands = options.testDebug?.verificationCommands ?? [];
        const analysis = options.testDebug?.analysis ?? '';
        return {
          subagent,
          ...base,
          structuredOutput: { type: 'test-debug', result: { debugEdits, verificationCommands, analysis } },
        };
      }
      case 'code-review': {
        const findings = options.codeReview?.findings ?? [];
        const approved = options.codeReview?.approved ?? true;
        return {
          subagent,
          ...base,
          structuredOutput: { type: 'code-review', result: { findings, approved } },
        };
      }
      case 'github': {
        const actions = options.github?.actions ?? [];
        return {
          subagent,
          ...base,
          structuredOutput: { type: 'github', result: { actions } },
        };
      }
    }
  };
}

function createAutoApprovingApprovalService(actionTypes: string[]): import('../workers/coding-worker/approvals/approval-service.js').CodingApprovalService {
  const inner = createInMemoryCodingApprovalService();
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === 'evaluateRequest') {
        return async (request: import('../workers/coding-worker/approvals/approval-types.js').CodingApprovalRequest) => {
          if (actionTypes.includes(request.actionType)) {
            return {
              allowed: true,
              requiresApproval: true,
              reason: 'Auto-approved by test harness.',
              status: 'approved',
            };
          }
          return target.evaluateRequest(request);
        };
      }
      return (target as unknown as Record<string, unknown>)[prop as string];
    },
  });
}
