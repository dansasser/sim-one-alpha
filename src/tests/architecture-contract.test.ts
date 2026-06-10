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
  const chatWorkflow = readText('src/workflows/chat.ts');

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
  assert.match(chatEventsRoute, /\/workflows\/chat/);
  assert.doesNotMatch(chatEventsRoute, /executionCtx/);
  assert.match(apiSecretMiddleware, /API_SECRET/);
  assert.match(chatWorkflow, /requireApiSecret/);
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
  assert.equal(config.subagents?.find((agent) => agent.name === 'researcher')?.model, undefined);
  assert.equal(config.subagents?.find((agent) => agent.name === 'coding-worker')?.model, false);
  assert.equal(config.tools?.some((tool) => tool.name === 'retrieve_context'), false);
  assert.equal(config.tools?.some((tool) => tool.name === 'web_research'), false);
  assert.match(config.instructions ?? '', /Main Agent Workspace Instructions/);
  assert.match(config.instructions ?? '', /Runtime Capabilities/);
  assert.match(config.instructions ?? '', /delegate with the Flue task tool using agent: "researcher"/);
  assert.match(config.instructions ?? '', /do not perform web search directly/i);
  assert.match(config.instructions ?? '', /depth: "deep"/);
  assert.match(config.instructions ?? '', /providerFailures/);
});

test('coding worker owns its workspace-backed placeholder profile', () => {
  const subagent = createCodingWorkerSubagent();

  assert.equal(subagent.name, 'coding-worker');
  assert.equal(subagent.model, false);
  assert.match(subagent.instructions ?? '', /Coding Worker Workspace Instructions/);
  assert.match(subagent.instructions ?? '', /placeholder-only/);
  assert.match(subagent.instructions ?? '', /No coding tools are currently attached/);
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
  };
}
