import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import orchestratorAgent from '../agents/orchestrator.js';
import { evaluateCodingApproval, createCodingApprovalRequest } from '../workers/coding-worker/approvals/approval-policy.js';
import {
  createFileCodingApprovalService,
  createInMemoryCodingApprovalService,
} from '../workers/coding-worker/approvals/approval-service.js';
import { createCodingGitHubTools } from '../workers/coding-worker/github/github-tools.js';
import { GhCliGitHubClient } from '../workers/coding-worker/github/gh-cli-client.js';
import { createCodingWorkerSubagent } from '../workers/coding-worker/coding-worker.js';
import { InMemoryCodingProgressReporter } from '../workers/coding-worker/events/progress-reporter.js';
import { createCodingWorkerEvent } from '../workers/coding-worker/events/coding-worker-events.js';
import { createOrchestratorProgressUpdate } from '../workers/coding-worker/events/orchestrator-bridge.js';
import { createCodingWorkerSessionPlan } from '../workers/coding-worker/session/child-session-names.js';
import {
  codingWorkerInternalSubagentNames,
  createCodingWorkerInternalSubagents,
} from '../workers/coding-worker/subagents/index.js';
import { readPackageScripts, runCodingRepoPreflight } from '../workers/coding-worker/repo/preflight.js';
import { parseGitStatusShort } from '../workers/coding-worker/repo/git-state.js';
import { InMemoryCodingRepoRegistry } from '../workers/coding-worker/repo/repo-registry.js';
import {
  packageManagerRunCommand,
  packageManagerTestCommand,
} from '../workers/coding-worker/repo/package-manager.js';
import { createCodingVerificationPlan } from '../workers/coding-worker/repo/verification.js';
import { createCodingGitTools } from '../workers/coding-worker/tools/coding-git-tools.js';
import { createCodingRepoTools } from '../workers/coding-worker/tools/coding-repo-tools.js';
import { createCodingRepoWorkflowTools } from '../workers/coding-worker/tools/coding-repo-workflow-tools.js';
import { evaluateCodingShellCommand } from '../workers/coding-worker/tools/command-policy.js';
import { createFlueLocalCodingSandbox } from '../workers/coding-worker/tools/sandbox-runtime.js';
import { resolveCodingWorkspaceTarget } from '../workers/coding-worker/repo/workspace-target.js';
import { JsonFileCodingTaskRunStore } from '../workers/coding-worker/session/task-run-store.js';
import { createFlueCodingSubagentDelegate } from '../workers/coding-worker/workflow/coordination.js';
import {
  createInitialCodingPlan,
  runCodingTaskWorkflow,
} from '../workers/coding-worker/workflow/coding-task.js';
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

test('coding worker live delegate uses Flue task delegation to worker-local subagent names', async () => {
  const workspaceRoot = createTempWorkspace();
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
    assert.match(calls[0]?.text ?? '', /delegate-session:triage/);
    assert.match(calls[0]?.text ?? '', /workspaceRoot/);
    assert.match(calls[0]?.text ?? '', /node custom-check\.js/);
    assert.doesNotMatch(calls[0]?.text ?? '', /node preflight-check\.js/);
    assert.equal(result.summary, 'triage complete');
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
  ) as { issue?: { title?: string }; checks?: Array<{ conclusion?: string }> };

  assert.equal(output.issue?.title, 'Fix parser');
  assert.equal(output.checks?.[0]?.conclusion, 'SUCCESS');
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
        }),
      /trusted decidedBy actor/,
    );

    await service.recordDecision({
      requestId: request.id,
      approved: true,
      decidedBy: 'operator',
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
  const client = new GhCliGitHubClient(undefined, async (args: string[]) => {
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
    const subagent = createCodingWorkerSubagent({
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
      available?: boolean;
      issue?: { title?: string };
      pullRequest?: { title?: string };
      checks?: Array<{ conclusion?: string }>;
    };

    assert.equal(context.available, true);
    assert.equal(context.issue?.title, 'Scoped issue');
    assert.equal(context.pullRequest?.title, 'Scoped PR');
    assert.equal(context.checks?.[0]?.conclusion, 'SUCCESS');

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
    comments?: Array<{ id: string }>;
    reviewThreads?: Array<{ id: string }>;
  };
  assert.equal(context.comments?.[0]?.id, 'comment-1');
  assert.equal(context.reviewThreads?.[0]?.id, 'thread-1');

  const updatePr = getTool(tools, 'coding_github_update_pr');
  const blocked = JSON.parse(
    await updatePr.execute({
      taskId: 'task-gh-update',
      owner: 'dansasser',
      repo: 'astro-flue-agent',
      pullRequestNumber: 13,
      body: 'Updated body',
    }),
  ) as { blocked?: boolean; request?: { id: string } };
  assert.equal(blocked.blocked, true);
  assert.ok(blocked.request?.id);
  assert.equal(updateCount, 0);

  await approvalService.recordDecision({
    requestId: blocked.request.id,
    approved: true,
    decidedBy: 'operator',
  });
  const approved = JSON.parse(
    await updatePr.execute({
      taskId: 'task-gh-update',
      owner: 'dansasser',
      repo: 'astro-flue-agent',
      pullRequestNumber: 13,
      body: 'Updated body',
    }),
  ) as { status?: string };
  assert.equal(approved.status, 'updated');
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
  ) as { verified?: boolean; mismatches?: string[] };
  assert.equal(verified.verified, true);
  assert.deepEqual(verified.mismatches, []);

  const mismatch = JSON.parse(
    await verifyPr.execute({
      owner: 'dansasser',
      repo: 'astro-flue-agent',
      pullRequestNumber: 13,
      expectedBase: 'main',
      expectedDraft: true,
    }),
  ) as { verified?: boolean; mismatches?: string[] };
  assert.equal(mismatch.verified, false);
  assert.match(mismatch.mismatches?.join('\n') ?? '', /Expected base main/);
  assert.match(mismatch.mismatches?.join('\n') ?? '', /Expected draft status true/);
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
    ) as { blocked?: boolean };

    assert.equal(output.blocked, true);
  } finally {
    rmSync(project.workspaceRoot, { recursive: true, force: true });
  }
});

test('coding task workflow emits completion telemetry for blocked verification commands', async () => {
  const project = createExecutableWorkspaceProject();
  const reporter = new InMemoryCodingProgressReporter();

  try {
    const result = await runCodingTaskWorkflow(
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
      { reporter },
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

test('coding task workflow emits public progress and blocks completion without verification evidence', async () => {
  const project = createExecutableWorkspaceProject();
  const reporter = new InMemoryCodingProgressReporter();

  try {
    const result = await runCodingTaskWorkflow(
      {
        taskId: 'task-no-verification',
        text: 'Implement a feature',
        workspaceRoot: project.workspaceRoot,
        targetKind: 'project',
        projectRelativePath: project.projectRelativePath,
      },
      {
        reporter,
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

test('coding task workflow edits a temp repo and completes only after verification passes', async () => {
  const project = createExecutableWorkspaceProject();

  try {
    const taskRunStore = JsonFileCodingTaskRunStore.atWorkspaceRoot(project.workspaceRoot);
    const result = await runCodingTaskWorkflow({
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
    }, { taskRunStore });

    assert.equal(result.status, 'completed');
    assert.match(readFileSync(join(project.repoPath, 'index.js'), 'utf8'), /return 42/);
    assert.equal(result.subagentResults.some((item) => item.subagent === 'implementer'), true);
    assert.equal(result.publicEvents.some((event) => JSON.stringify(event).includes('coding.verification.completed')), true);
    assert.doesNotThrow(() => assertCodingWorkerCanComplete(result));
    const stored = await taskRunStore.get('task-with-real-edit');
    assert.equal(stored?.status, 'completed');
    assert.equal(stored?.sessionPlan.childSessions.implementer.includes(':implementer'), true);
    assert.equal(stored?.events.some((event) => event.type === 'coding.completed'), true);
  } finally {
    rmSync(project.workspaceRoot, { recursive: true, force: true });
  }
});

test('coding task workflow debug loop patches after a failed verification run', async () => {
  const project = createExecutableWorkspaceProject();

  try {
    const result = await runCodingTaskWorkflow({
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
    });

    assert.equal(result.status, 'completed');
    assert.match(readFileSync(join(project.repoPath, 'index.js'), 'utf8'), /return 42/);
    assert.equal(result.verification.evidence.some((item) => item.status === 'failed'), true);
    assert.equal(result.verification.evidence.some((item) => item.status === 'passed'), true);
  } finally {
    rmSync(project.workspaceRoot, { recursive: true, force: true });
  }
});

test('coding task workflow can complete with passing required verification evidence', async () => {
  const project = createExecutableWorkspaceProject();

  try {
  const result = await runCodingTaskWorkflow(
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

interface TempWorkspaceProject {
  workspaceRoot: string;
  projectRelativePath: string;
  repoPath: string;
}

function createTempWorkspace() {
  return mkdtempSync(join(tmpdir(), 'coding-worker-workspace-'));
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
