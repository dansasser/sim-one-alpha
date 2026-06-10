import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { SessionData } from '@flue/runtime';
import orchestratorAgent from '../agents/orchestrator.js';
import {
  createFlueSessionStorageKey,
  parseFlueSessionStorageKey,
} from '../session/flue-session-store.js';
import { createGoromboPersistenceRuntime } from '../session/session-persistence.js';

test('Flue session storage keys can be parsed into stable logical session parts', () => {
  const storageKey = createFlueSessionStorageKey('workflow-run-1', 'gorombo-orchestrator', 'support');

  assert.deepEqual(parseFlueSessionStorageKey(storageKey), {
    instanceId: 'workflow-run-1',
    harnessName: 'gorombo-orchestrator',
    sessionName: 'support',
  });
});

test('GOROMBO persistence wrapper loads latest logical session across workflow run ids', async () => {
  const runtime = createTestPersistenceRuntime();
  const firstRunKey = createFlueSessionStorageKey('workflow-run-1', 'gorombo-orchestrator', 'support');
  const secondRunKey = createFlueSessionStorageKey('workflow-run-2', 'gorombo-orchestrator', 'support');
  const data = createStoredSessionData();

  await runtime.adapter.migrate?.();
  const store = runtime.adapter.connect().sessions;
  await store.save(firstRunKey, data);

  assert.deepEqual(await store.load(secondRunKey), data);
  assert.deepEqual(await runtime.getLatestSessionData('gorombo-orchestrator', 'support'), data);

  await runtime.adapter.close?.();
  runtime.cleanup();
});

test('GOROMBO persistence wrapper deletes the logical session when called from a new run id', async () => {
  const runtime = createTestPersistenceRuntime();
  const firstRunKey = createFlueSessionStorageKey('workflow-run-1', 'gorombo-orchestrator', 'support');
  const secondRunKey = createFlueSessionStorageKey('workflow-run-2', 'gorombo-orchestrator', 'support');

  await runtime.adapter.migrate?.();
  const store = runtime.adapter.connect().sessions;
  await store.save(firstRunKey, createStoredSessionData());
  await store.delete(secondRunKey);

  assert.equal(await store.load(firstRunKey), null);
  assert.equal(await runtime.getLatestSessionData('gorombo-orchestrator', 'support'), null);

  await runtime.adapter.close?.();
  runtime.cleanup();
});

test('GOROMBO persistence wrapper indexes saved Flue session data for session memory retrieval', async () => {
  const runtime = createTestPersistenceRuntime();
  const storageKey = createFlueSessionStorageKey('workflow-run-memory', 'gorombo-orchestrator', 'memory-support');

  await runtime.adapter.migrate?.();
  const store = runtime.adapter.connect().sessions;
  await store.save(storageKey, createStoredSessionData('Remember the neon invoice audit.'));

  const matches = runtime.sessionDatabase.searchSessionMemory({
    text: 'neon invoice',
    limit: 5,
  });

  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.sessionName, 'memory-support');
  assert.match(matches[0]?.content ?? '', /neon invoice audit/);

  await runtime.adapter.close?.();
  runtime.cleanup();
});

test('orchestrator uses Flue db.ts persistence instead of per-agent persist', async () => {
  const config = await orchestratorAgent.initialize({
    id: 'workflow-run-1',
    env: createModelEnv(),
    payload: undefined,
  });

  assert.equal('persist' in config, false);
  assert.equal(config.subagents?.some((agent) => agent.name === 'researcher'), true);
  assert.equal(config.tools?.some((tool) => tool.name === 'retrieve_context'), false);
  assert.equal(config.tools?.some((tool) => tool.name === 'web_research'), false);
  assert.match(config.instructions ?? '', /agent: "researcher"/);
  assert.match(config.instructions ?? '', /task/);
});

function createTestPersistenceRuntime() {
  const directory = mkdtempSync(join(tmpdir(), 'gorombo-session-'));
  const runtime = createGoromboPersistenceRuntime({
    version: 1,
    models: {
      primary: 'minimax-m3-cloud',
    },
    storage: {
      flueDatabasePath: join(directory, 'flue.sqlite'),
      sessionDatabasePath: join(directory, 'sessions.sqlite'),
    },
  });

  return {
    ...runtime,
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function createStoredSessionData(text = 'Hello'): SessionData {
  return {
    version: 5,
    affinityKey: 'test-affinity',
    entries: [
      {
        type: 'message',
        id: 'user-1',
        parentId: null,
        timestamp: '2026-06-07T00:00:00.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text }],
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
