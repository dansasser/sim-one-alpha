import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import orchestratorAgent from '../agents/orchestrator.js';
import { createResearcherSubagent } from '../agents/researcher.js';

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

test('legacy orchestrator scaffold cannot create a direct web-search path', () => {
  const legacyOrchestrator = readText('src/orchestrator/orchestrator.ts');

  assert.doesNotMatch(legacyOrchestrator, /createDefaultWebSearchProvider/);
  assert.doesNotMatch(legacyOrchestrator, /webSearchProvider/);
  assert.doesNotMatch(legacyOrchestrator, /new RagRouter/);
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
  assert.equal(config.subagents?.find((agent) => agent.name === 'researcher')?.model, undefined);
  assert.equal(config.tools?.some((tool) => tool.name === 'retrieve_context'), false);
  assert.equal(config.tools?.some((tool) => tool.name === 'web_research'), false);
  assert.match(config.instructions ?? '', /delegate with the Flue task tool using agent: "researcher"/);
  assert.match(config.instructions ?? '', /do not perform web search directly/i);
});

test('researcher owns the web research tool', () => {
  const subagent = createResearcherSubagent('ollama-cloud/minimax-m3');

  assert.equal(subagent.tools?.some((tool) => tool.name === 'web_research'), true);
  assert.equal(subagent.tools?.some((tool) => tool.name === 'retrieve_context'), false);
  assert.match(subagent.instructions ?? '', /Own all web research behavior/);
});

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

function createModelEnv(): Record<string, string> {
  return {
    OLLAMA_API_KEY: 'test-key',
    CODEX_BRAIN_LOCAL_API_KEY: 'test-key',
    CODEX_BRAIN_LOCAL_API_URL: 'https://dt1.example.test/v1',
  };
}
