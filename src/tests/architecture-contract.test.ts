import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import orchestratorAgent from '../agents/orchestrator.js';
import { createCodingWorkerSubagent } from '../engine/workers/coding-worker/coding-worker.js';
import { createResearcherSubagent } from '../engine/workers/researcher/researcher.js';
import { resolveCodingWorkerWorkspaceRoot as resolveCodingWorkerWorkspaceRootFromOrchestrator } from '../agents/orchestrator.js';

test('root and architecture docs preserve the Flue component contract', () => {
  const agents = readText('AGENTS.md');
  const flueArchitecture = readText('docs/architecture/flue-architecture.md');
  const goromboMap = readText('docs/architecture/gorombo-flue-map.md');

  assert.match(agents, /docs\/architecture\/flue-architecture\.md/);
  assert.match(agents, /docs\/architecture\/gorombo-flue-map\.md/);
  assert.match(flueArchitecture, /workflows/);
  assert.match(flueArchitecture, /The orchestrator must not directly call web search/);
  assert.match(goromboMap, /src\/workflows\/web-research\.ts/);
  assert.match(goromboMap, /`src\/app\.ts` must stay close/);
});

test('app.ts stays a Flue app shell and does not bypass agents or cards', () => {
  const app = readText('src/app.ts');
  const chatEventsRoute = readText('src/api/routes/chat-events.ts');
  const apiSecretMiddleware = readText('src/api/middleware/api-secret.ts');

  assert.match(app, /app\.route\('\/', flue\(\)\)/);
  assert.match(app, /models\/runtime\.js/);
  assert.match(app, /registerChatEventRoutes\(app\)/);
  assert.match(app, /app\.use\('\/agents\/\*', requireApiSecret\)/);
  assert.match(app, /app\.use\('\/workflows\/\*', requireApiSecret\)/);
  assert.match(app, /app\.use\('\/runs\/\*', requireApiSecret\)/);
  assert.doesNotMatch(app, /createDefaultOrchestrator/);
  assert.doesNotMatch(app, /configureModelProviders/);
  assert.doesNotMatch(app, /process\.env/);
  assert.doesNotMatch(app, /API_SECRET/);
  assert.doesNotMatch(app, /executionCtx/);
  assert.doesNotMatch(app, /createDefaultWebSearchProvider/);
  assert.match(chatEventsRoute, /\/api\/chat\/events/);
  assert.match(chatEventsRoute, /\/agents\/orchestrator/);
  assert.doesNotMatch(chatEventsRoute, /app\.request\(\s*[`'"]\/workflows\//);
  assert.doesNotMatch(chatEventsRoute, /executionCtx/);
  assert.match(apiSecretMiddleware, /API_SECRET/);
  assert.equal(existsSync(['src', 'engine', 'workflows', 'chat.ts'].join('/')), false);
});

test('legacy non-Flue orchestrator and gateway paths stay removed', () => {
  assert.equal(existsSync('src/orchestrator/orchestrator.ts'), false);
  assert.equal(existsSync('src/gateway/secure-web-api.ts'), false);
});

test('GOROMBO Flue map documents every top-level source directory', () => {
  const goromboMap = readText('docs/architecture/gorombo-flue-map.md');
  const topLevelDirectories = readdirSync('src', { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `src/${entry.name}/`);

  for (const directory of topLevelDirectories) {
    assert.match(goromboMap, new RegExp(escapeRegExp(directory)));
  }

  assert.match(goromboMap, /src\/workspace-loader\.ts/);
  assert.match(goromboMap, /root support file/);
});

test('low-level web retrieval workflows are internal machinery, not public routes', () => {
  assert.doesNotMatch(readText('src/workflows/retrieval.ts'), /export const route/);
  assert.doesNotMatch(readText('src/workflows/web-research.ts'), /export const route/);
});

test('Flue orchestrator routes research to the researcher instead of owning web tools', async () => {
  const config = await orchestratorAgent.initialize({
    id: 'architecture-contract',
    env: createModelEnv(),
    payload: undefined,
  });

  assert.equal(config.subagents?.some((agent) => agent.name === 'researcher'), true);
  assert.equal(config.subagents?.some((agent) => agent.name === 'coding-worker'), true);
  const orchestratorExposedInternal = (config.subagents ?? [])
    .map((agent) => agent.name)
    .filter((name): name is string => typeof name === 'string')
    .filter((name) => name.startsWith('coding-worker-') && name !== 'coding-worker');
  assert.deepEqual(orchestratorExposedInternal, []);
  assert.equal(config.subagents?.find((agent) => agent.name === 'researcher')?.model, undefined);
  assert.equal(config.subagents?.find((agent) => agent.name === 'coding-worker')?.model, undefined);
  assert.equal(config.tools?.some((tool) => tool.name === 'retrieve_context'), false);
  assert.equal(config.tools?.some((tool) => tool.name === 'web_research'), false);
  assert.equal(config.tools?.some((tool) => tool.name === 'coding_github_read_context'), false);
  assert.equal(config.tools?.some((tool) => tool.name === 'coding_repo_apply_patch'), false);
  assert.equal(config.tools?.some((tool) => tool.name === 'coding_git_commit'), false);
  assert.equal(config.tools?.some((tool) => tool.name === 'coding_repo_discover'), false);
  assert.equal(config.tools?.some((tool) => tool.name === 'coding_repo_clone'), false);
  assert.equal(config.tools?.some((tool) => tool.name === 'coding_repo_branch_create'), false);
  assert.equal(config.tools?.some((tool) => tool.name === 'coding_repo_sync'), false);
  assert.equal(config.tools?.some((tool) => tool.name === 'github_auth_start'), false);
  assert.match(config.instructions ?? '', /Main Agent Workspace Instructions/);
  assert.match(config.instructions ?? '', /Runtime Capabilities/);
  assert.match(config.instructions ?? '', /delegate with the Flue task tool using agent: "researcher"/);
  assert.match(config.instructions ?? '', /agent: "coding-worker"/);
  assert.match(config.instructions ?? '', /Do not call coding-worker internal subagents directly/);
  assert.match(config.instructions ?? '', /do not perform web search directly/i);
  assert.match(config.instructions ?? '', /depth: "deep"/);
  assert.match(config.instructions ?? '', /providerFailures/);
  assert.match(config.instructions ?? '', /Worker-backed capabilities count as capabilities of this main agent/);
  assert.match(config.instructions ?? '', /repository work and GitHub work through the Coding Worker/i);
  assert.match(config.instructions ?? '', /does not establish that a specific provider account is authenticated/i);
});

test('Flue orchestrator defaults coding-worker workspace root to src/workspace/', async () => {
  const { GOROMBO_WORKSPACE_ROOT: _workspaceRoot, ...envWithoutWorkspaceRoot } = createModelEnv();

  const defaultRoot = resolveCodingWorkerWorkspaceRootFromOrchestrator(envWithoutWorkspaceRoot);
  assert.ok(defaultRoot.endsWith('src/workspace'), `expected root ending in src/workspace, got ${defaultRoot}`);

  const config = await orchestratorAgent.initialize({
    id: 'architecture-contract-default-workspace-root',
    env: envWithoutWorkspaceRoot,
    payload: undefined,
  });

  const codingWorker = config.subagents?.find((agent) => agent.name === 'coding-worker');
  assert.ok(codingWorker);

  const repoTool = codingWorker.tools?.find((tool) => tool.name === 'coding_repo_apply_patch');
  assert.ok(repoTool);
});

test('coding worker owns its workspace-backed lead profile', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'coding-worker-workspace-'));
  const approvalRoot = mkdtempSync(join(tmpdir(), 'coding-worker-approvals-'));
  try {
    const subagent = await createCodingWorkerSubagent({ workspaceRoot, approvalRoot });

    assert.equal(subagent.name, 'coding-worker');
  assert.equal(subagent.model, undefined);
  assert.match(subagent.instructions ?? '', /Coding Worker Workspace Instructions/);
  assert.match(subagent.instructions ?? '', /worker-local internal subagents/);
  assert.match(subagent.instructions ?? '', /Do not expose raw hidden thinking/);
  assert.deepEqual(
    (subagent.subagents ?? []).map((agent) => agent.name).sort(),
    [
      'coding-worker-code-review',
      'coding-worker-github',
      'coding-worker-implementer',
      'coding-worker-test-debug',
      'coding-worker-triage',
    ],
  );
  assert.equal(subagent.tools?.some((tool) => tool.name === 'coding_github_read_context'), true);
  assert.equal(subagent.tools?.some((tool) => tool.name === 'coding_project_create'), true);
  assert.equal(subagent.tools?.some((tool) => tool.name === 'coding_repo_apply_patch'), true);
  assert.equal(subagent.tools?.some((tool) => tool.name === 'coding_repo_discover'), true);
  assert.equal(subagent.tools?.some((tool) => tool.name === 'coding_repo_clone'), true);
  assert.equal(subagent.tools?.some((tool) => tool.name === 'coding_repo_branch_create'), true);
  assert.equal(subagent.tools?.some((tool) => tool.name === 'coding_repo_sync'), true);
  assert.equal(subagent.tools?.some((tool) => tool.name === 'coding_shell_run'), true);
  assert.equal(subagent.tools?.some((tool) => tool.name === 'coding_git_commit'), true);
  assert.equal(subagent.tools?.some((tool) => tool.name === 'github_auth_status'), true);
  assert.equal(subagent.tools?.some((tool) => tool.name === 'github_auth_start'), true);
  assert.equal(
    subagent.subagents?.find((agent) => agent.name === 'coding-worker-implementer')?.tools?.some(
      (tool) => tool.name === 'coding_repo_apply_patch',
    ),
    true,
  );
  assert.match(subagent.instructions ?? '', /GitHub authentication is runtime state, not a `?TOOLS\.md`? flag/i);
  assert.match(subagent.instructions ?? '', /first GitHub operation/i);
  assert.equal(
    subagent.subagents?.find((agent) => agent.name === 'coding-worker-test-debug')?.tools?.some(
      (tool) => tool.name === 'coding_shell_run',
    ),
    true,
  );
  assert.equal(
    subagent.subagents?.find((agent) => agent.name === 'coding-worker-github')?.tools?.some(
      (tool) => tool.name === 'coding_github_verify_pr',
    ),
    true,
  );
  assert.equal(
    subagent.subagents?.find((agent) => agent.name === 'coding-worker-github')?.tools?.some(
      (tool) => tool.name === 'coding_github_update_pr',
    ),
    true,
  );
  assert.equal(
    subagent.subagents?.find((agent) => agent.name === 'coding-worker-github')?.tools?.some(
      (tool) => tool.name === 'github_auth_start',
    ),
    false,
  );
  assert.equal(subagent.skills?.some((skill) => skill.name === 'coding-worker.code-change-loop'), true);
  assert.equal(existsSync('src/workflows/coding-task.ts'), false);
  assert.equal(existsSync('src/agents/coding-worker.ts'), false);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(approvalRoot, { recursive: true, force: true });
  }
});


test('coding worker lead loop is documented in profile instructions', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'coding-worker-workspace-'));
  const approvalRoot = mkdtempSync(join(tmpdir(), 'coding-worker-approvals-'));
  try {
    const subagent = await createCodingWorkerSubagent({ workspaceRoot, approvalRoot });

    assert.match(subagent.instructions ?? '', /Lead Loop Contract/);
    assert.match(subagent.instructions ?? '', /bounded, approval-gated, Flue-native tool-calling loop/);
    assert.match(subagent.instructions ?? '', /max turns: 10/i);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(approvalRoot, { recursive: true, force: true });
  }
});

test('coding worker progress events cover every defined loop checkpoint', async () => {
  const { createCodingWorkerEvent } = await import('../engine/workers/coding-worker/events/coding-worker-events.js');
  const checkpointTypes = [
    'coding.task.accepted',
    'coding.triage.started',
    'coding.triage.completed',
    'coding.implementer.started',
    'coding.implementer.completed',
    'coding.test-debug.started',
    'coding.test-debug.completed',
    'coding.review.started',
    'coding.review.completed',
    'coding.github.started',
    'coding.github.completed',
    'coding.replanned',
    'coding.blocked',
    'coding.completed',
    'coding.error',
  ];

  for (const type of checkpointTypes) {
    assert.doesNotThrow(() =>
      createCodingWorkerEvent({
        type: type as import('../engine/workers/coding-worker/events/coding-worker-events.js').CodingWorkerEventType,
        taskId: 'checkpoint-test',
        summary: `${type} event.`,
      }),
    );
  }
});

test('orchestrator only exposes the coding-worker lead, not internal subagents', async () => {
  const config = await orchestratorAgent.initialize({
    id: 'architecture-contract-internal-subagents',
    env: createModelEnv(),
    payload: undefined,
  });

  const exposedInternal = (config.subagents ?? [])
    .map((agent) => agent.name)
    .filter((name): name is string => typeof name === 'string')
    .filter((name) => name.startsWith('coding-worker-') && name !== 'coding-worker');
  assert.deepEqual(exposedInternal, []);

  assert.equal(config.subagents?.some((agent) => agent.name === 'coding-worker'), true);
});

test('researcher owns the web research tool', () => {
  const subagent = createResearcherSubagent('ollama-cloud/minimax-m3');

  assert.equal(subagent.tools?.some((tool) => tool.name === 'web_research'), true);
  assert.equal(subagent.tools?.some((tool) => tool.name === 'retrieve_context'), false);
  assert.match(subagent.instructions ?? '', /source-backed web research/);
  assert.match(subagent.instructions ?? '', /Researcher Workspace Instructions/);
});

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createModelEnv(): Record<string, string> {
  return {
    OLLAMA_API_KEY: 'test-key',
    CODEX_BRAIN_LOCAL_API_KEY: 'test-key',
    CODEX_BRAIN_LOCAL_API_URL: 'https://dt1.example.test/v1',
    GOROMBO_WORKSPACE_ROOT: process.cwd(),
  };
}
