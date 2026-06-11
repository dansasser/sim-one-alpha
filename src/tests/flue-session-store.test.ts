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

  try {
    const firstRunKey = createFlueSessionStorageKey('workflow-run-1', 'gorombo-orchestrator', 'support');
    const secondRunKey = createFlueSessionStorageKey('workflow-run-2', 'gorombo-orchestrator', 'support');
    const data = createStoredSessionData();

    await runtime.adapter.migrate?.();
    const store = runtime.adapter.connect().sessions;
    await store.save(firstRunKey, data);

    assert.deepEqual(await store.load(secondRunKey), data);
    assert.deepEqual(await runtime.getLatestSessionData('gorombo-orchestrator', 'support'), data);
  } finally {
    await runtime.adapter.close?.();
    runtime.cleanup();
  }
});

test('GOROMBO persistence wrapper deletes the logical session when called from a new run id', async () => {
  const runtime = createTestPersistenceRuntime();

  try {
    const firstRunKey = createFlueSessionStorageKey('workflow-run-1', 'gorombo-orchestrator', 'support');
    const secondRunKey = createFlueSessionStorageKey('workflow-run-2', 'gorombo-orchestrator', 'support');

    await runtime.adapter.migrate?.();
    const store = runtime.adapter.connect().sessions;
    await store.save(firstRunKey, createStoredSessionData());
    await store.delete(secondRunKey);

    assert.equal(await store.load(firstRunKey), null);
    assert.equal(await runtime.getLatestSessionData('gorombo-orchestrator', 'support'), null);
  } finally {
    await runtime.adapter.close?.();
    runtime.cleanup();
  }
});

test('GOROMBO persistence wrapper indexes saved Flue session data for session memory retrieval', async () => {
  const runtime = createTestPersistenceRuntime();

  try {
    const storageKey = createFlueSessionStorageKey('workflow-run-memory', 'gorombo-orchestrator', 'memory-support');
    runtime.sessionDatabase.ensureChatSession({
      sessionId: 'memory-support',
      origin: 'web',
      actorId: 'actor-memory',
      conversationId: 'conversation-memory',
    });

    await runtime.adapter.migrate?.();
    const store = runtime.adapter.connect().sessions;
    await store.save(storageKey, createStoredSessionData('Remember the neon invoice audit.'));

    const matches = runtime.sessionDatabase.searchSessionMemory({
      text: 'neon invoice',
      actorId: 'actor-memory',
      conversationId: 'conversation-memory',
      limit: 5,
    });

    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.sessionName, 'memory-support');
    assert.equal(matches[0]?.actorId, 'actor-memory');
    assert.match(matches[0]?.content ?? '', /neon invoice audit/);
    assert.deepEqual(
      runtime.sessionDatabase.searchSessionMemory({
        text: 'neon invoice',
        limit: 5,
      }),
      [],
    );
  } finally {
    await runtime.adapter.close?.();
    runtime.cleanup();
  }
});

test('session memory retrieval is scoped to the current actor or conversation', async () => {
  const runtime = createTestPersistenceRuntime();

  try {
    await runtime.adapter.migrate?.();
    const store = runtime.adapter.connect().sessions;
    runtime.sessionDatabase.ensureChatSession({
      sessionId: 'memory-user-a',
      origin: 'web',
      actorId: 'actor-a',
      conversationId: 'conversation-a',
    });
    runtime.sessionDatabase.ensureChatSession({
      sessionId: 'memory-user-b',
      origin: 'web',
      actorId: 'actor-b',
      conversationId: 'conversation-b',
    });

    await store.save(
      createFlueSessionStorageKey('workflow-run-a', 'gorombo-orchestrator', 'memory-user-a'),
      createStoredSessionData('Remember the neon invoice audit for user A.'),
    );
    await store.save(
      createFlueSessionStorageKey('workflow-run-b', 'gorombo-orchestrator', 'memory-user-b'),
      createStoredSessionData('Remember the neon invoice audit for user B.'),
    );

    const matches = runtime.sessionDatabase.searchSessionMemory({
      text: 'neon invoice audit',
      actorId: 'actor-a',
      conversationId: 'conversation-a',
      limit: 5,
    });

    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.sessionName, 'memory-user-a');
    assert.doesNotMatch(matches[0]?.content ?? '', /user B/);
  } finally {
    await runtime.adapter.close?.();
    runtime.cleanup();
  }
});

test('session memory indexing skips thinking blocks', async () => {
  const runtime = createTestPersistenceRuntime();

  try {
    await runtime.adapter.migrate?.();
    const store = runtime.adapter.connect().sessions;
    runtime.sessionDatabase.ensureChatSession({
      sessionId: 'thinking-memory',
      origin: 'web',
      actorId: 'actor-thinking',
      conversationId: 'conversation-thinking',
    });

    await store.save(
      createFlueSessionStorageKey('workflow-run-thinking', 'gorombo-orchestrator', 'thinking-memory'),
      createStoredSessionData([
        { type: 'text', text: 'Visible invoice context.' },
        { type: 'thinking', thinking: 'secret hidden reasoning should not be indexed' },
      ]),
    );

    assert.equal(
      runtime.sessionDatabase.searchSessionMemory({
        text: 'hidden reasoning',
        actorId: 'actor-thinking',
        conversationId: 'conversation-thinking',
        limit: 5,
      }).length,
      0,
    );
    assert.equal(
      runtime.sessionDatabase.searchSessionMemory({
        text: 'visible invoice',
        actorId: 'actor-thinking',
        conversationId: 'conversation-thinking',
        limit: 5,
      }).length,
      1,
    );
  } finally {
    await runtime.adapter.close?.();
    runtime.cleanup();
  }
});

test('GOROMBO persistence wrapper restores the previous logical session when the latest snapshot is deleted', async () => {
  const runtime = createTestPersistenceRuntime();

  try {
    const firstRunKey = createFlueSessionStorageKey('workflow-run-1', 'gorombo-orchestrator', 'support');
    const secondRunKey = createFlueSessionStorageKey('workflow-run-2', 'gorombo-orchestrator', 'support');
    const firstData = createStoredSessionData('first support snapshot', '2026-06-07T00:00:00.000Z');
    const secondData = createStoredSessionData('second support snapshot', '2026-06-07T00:01:00.000Z');

    await runtime.adapter.migrate?.();
    const store = runtime.adapter.connect().sessions;
    await store.save(firstRunKey, firstData);
    await store.save(secondRunKey, secondData);
    assert.deepEqual(await runtime.getLatestSessionData('gorombo-orchestrator', 'support'), secondData);

    await store.delete(secondRunKey);

    assert.deepEqual(await runtime.getLatestSessionData('gorombo-orchestrator', 'support'), firstData);
  } finally {
    await runtime.adapter.close?.();
    runtime.cleanup();
  }
});

test('GOROMBO persistence wrapper keeps the latest logical session when an older exact snapshot is deleted', async () => {
  const runtime = createTestPersistenceRuntime();

  try {
    const firstRunKey = createFlueSessionStorageKey('workflow-run-1', 'gorombo-orchestrator', 'support');
    const secondRunKey = createFlueSessionStorageKey('workflow-run-2', 'gorombo-orchestrator', 'support');
    const firstData = createStoredSessionData('first support snapshot', '2026-06-07T00:00:00.000Z');
    const secondData = createStoredSessionData('second support snapshot', '2026-06-07T00:01:00.000Z');

    await runtime.adapter.migrate?.();
    const store = runtime.adapter.connect().sessions;
    await store.save(firstRunKey, firstData);
    await store.save(secondRunKey, secondData);

    await store.delete(firstRunKey);

    assert.equal(runtime.sessionDatabase.getLatestStorageKey('gorombo-orchestrator', 'support'), secondRunKey);
    assert.deepEqual(await runtime.getLatestSessionData('gorombo-orchestrator', 'support'), secondData);
    assert.deepEqual(await store.load(secondRunKey), secondData);
  } finally {
    await runtime.adapter.close?.();
    runtime.cleanup();
  }
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

function createStoredSessionData(
  content: string | Array<Record<string, unknown>> = 'Hello',
  updatedAt = '2026-06-07T00:00:00.000Z',
): SessionData {
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
          content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
        },
        source: 'prompt',
      },
    ],
    leafId: 'user-1',
    metadata: {},
    createdAt: '2026-06-07T00:00:00.000Z',
    updatedAt,
  } as unknown as SessionData;
}

function createModelEnv(): Record<string, string> {
  return {
    OLLAMA_API_KEY: 'test-key',
    CODEX_BRAIN_LOCAL_API_KEY: 'test-key',
    CODEX_BRAIN_LOCAL_API_URL: 'https://dt1.example.test/v1',
  };
}
