import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionData } from '@flue/runtime';
import orchestratorAgent from '../agents/orchestrator.js';
import {
  InMemoryFlueSessionStore,
  createFlueSessionStorageKey,
  goromboFlueSessionStore,
  parseFlueSessionStorageKey,
} from '../session/flue-session-store.js';

test('Flue session storage keys can be parsed into stable logical session parts', () => {
  const storageKey = createFlueSessionStorageKey('workflow-run-1', 'gorombo-orchestrator', 'support');

  assert.deepEqual(parseFlueSessionStorageKey(storageKey), {
    instanceId: 'workflow-run-1',
    harnessName: 'gorombo-orchestrator',
    sessionName: 'support',
  });
});

test('project Flue session store loads the latest logical session across workflow run ids', async () => {
  const store = new InMemoryFlueSessionStore();
  const firstRunKey = createFlueSessionStorageKey('workflow-run-1', 'gorombo-orchestrator', 'support');
  const secondRunKey = createFlueSessionStorageKey('workflow-run-2', 'gorombo-orchestrator', 'support');
  const data = createStoredSessionData();

  await store.save(firstRunKey, data);

  assert.deepEqual(await store.load(secondRunKey), data);
  assert.deepEqual(store.getLatestSessionData('gorombo-orchestrator', 'support'), data);
});

test('project Flue session store deletes the logical session when called from a new run id', async () => {
  const store = new InMemoryFlueSessionStore();
  const firstRunKey = createFlueSessionStorageKey('workflow-run-1', 'gorombo-orchestrator', 'support');
  const secondRunKey = createFlueSessionStorageKey('workflow-run-2', 'gorombo-orchestrator', 'support');

  await store.save(firstRunKey, createStoredSessionData());
  await store.delete(secondRunKey);

  assert.equal(await store.load(firstRunKey), null);
  assert.equal(store.getLatestSessionData('gorombo-orchestrator', 'support'), null);
});

test('orchestrator uses the project Flue session store', async () => {
  const config = await orchestratorAgent.initialize({
    id: 'workflow-run-1',
    env: createModelEnv(),
    payload: undefined,
  });

  assert.equal(config.persist, goromboFlueSessionStore);
  assert.equal(config.subagents?.some((agent) => agent.name === 'researcher'), true);
  assert.equal(config.tools?.some((tool) => tool.name === 'retrieve_context'), false);
  assert.equal(config.tools?.some((tool) => tool.name === 'web_research'), false);
  assert.match(config.instructions ?? '', /agent: "researcher"/);
  assert.match(config.instructions ?? '', /task/);
});

function createStoredSessionData(): SessionData {
  return {
    version: 4,
    entries: [
      {
        type: 'message',
        id: 'user-1',
        parentId: null,
        timestamp: '2026-06-07T00:00:00.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Hello' }],
        },
        source: 'prompt',
      },
    ],
    leafId: 'user-1',
    metadata: {},
    createdAt: '2026-06-07T00:00:00.000Z',
    updatedAt: '2026-06-07T00:00:00.000Z',
  } as SessionData;
}

function createModelEnv(): Record<string, string> {
  return {
    OLLAMA_API_KEY: 'test-key',
    CODEX_BRAIN_LOCAL_API_KEY: 'test-key',
    CODEX_BRAIN_LOCAL_API_URL: 'https://dt1.example.test/v1',
  };
}
