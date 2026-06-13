import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import orchestratorAgent from '../agents/orchestrator.js';
import { createCodingWorkerSubagent } from '../workers/coding-worker/coding-worker.js';
import { createResearcherSubagent } from '../workers/researcher/researcher.js';

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
  const chatEventsRoute = readText('src/routes/chat-events.ts');
  const apiSecretMiddleware = readText('src/middleware/api-secret.ts');

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
  assert.equal(existsSync(['src', 'workflows', 'chat.ts'].join('/')), false);
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
  assert.match(config.instructions ?? '', /Main Agent Workspace Instructions/);
  assert.match(config.instructions ?? '', /Runtime Capabilities/);
  assert.match(config.instructions ?? '', /delegate with the Flue task tool using agent: "researcher"/);
  assert.match(config.instructions ?? '', /agent: "coding-worker"/);
  assert.match(config.instructions ?? '', /Do not call coding-worker internal subagents directly/);
  assert.match(config.instructions ?? '', /do not perform web search directly/i);
  assert.match(config.instructions ?? '', /depth: "deep"/);
  assert.match(config.instructions ?? '', /providerFailures/);
});

test('Flue orchestrator requires an explicit coding-worker workspace root', async () => {
  const { GOROMBO_WORKSPACE_ROOT: _workspaceRoot, ...envWithoutWorkspaceRoot } = createModelEnv();

  await assert.rejects(
    async () => {
      await Promise.resolve(orchestratorAgent.initialize({
        id: 'architecture-contract-missing-workspace-root',
        env: envWithoutWorkspaceRoot,
        payload: undefined,
      }));
    },
    /Missing coding-worker workspace root configuration/,
  );
});

test('coding worker owns its workspace-backed lead profile', () => {
  const subagent = createCodingWorkerSubagent({ workspaceRoot: process.cwd() });

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
  assert.equal(subagent.tools?.some((tool) => tool.name === 'coding_shell_run'), true);
  assert.equal(subagent.tools?.some((tool) => tool.name === 'coding_git_commit'), true);
  assert.equal(subagent.skills?.some((skill) => skill.name === 'coding-worker.code-change-loop'), true);
  assert.equal(existsSync('src/workflows/coding-task.ts'), false);
  assert.equal(existsSync('src/agents/coding-worker.ts'), false);
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
