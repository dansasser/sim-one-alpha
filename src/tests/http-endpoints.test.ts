import assert from 'node:assert/strict';
import test from 'node:test';
import type { FlueEvent, FlueSession } from '@flue/runtime';
import { Hono } from 'hono';
import app from '../app.js';
import { goromboPersistenceRuntime } from '../db.js';
import { requireApiSecret } from '../api/middleware/api-secret.js';
import { registerChatEventRoutes } from '../api/routes/chat-events.js';
import { registerTelemetryRoutes } from '../api/routes/telemetry.js';
import { flueTelemetryStore } from '../core/telemetry/flue-telemetry.js';

test('chat endpoints fail closed when API_SECRET is not configured', async () => {
  await withApiSecret(undefined, async () => {
    const response = await app.request('/api/chat/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'API secret is not configured' });
  });
});

test('chat event ingress uses runtime API_SECRET when Hono env bindings are empty', async () => {
  await withApiSecret('test-secret', async () => {
    const response = await app.request('/api/chat/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'Unauthorized' });
  });
});

test('chat event ingress returns 400 for invalid JSON after auth passes', async () => {
  await withApiSecret('test-secret', async () => {
    const response = await app.request('/api/chat/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-secret': 'test-secret',
      },
      body: '{not valid json',
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Invalid JSON payload' });
  });
});

test('chat session list endpoint returns the stored session list after auth passes', async () => {
  await withApiSecret('test-secret', async () => {
    const response = await app.request('/api/chat/sessions', {
      headers: { 'x-api-secret': 'test-secret' },
    });

    assert.equal(response.status, 200);
    const body = await response.json() as { sessions?: unknown };
    assert.equal(Array.isArray(body.sessions), true);
  });
});

test('chat event ingress enters the durable orchestrator agent route', async () => {
  const testApp = new Hono();
  let promptedAgent = false;

  testApp.use('/agents/*', requireApiSecret);
  registerChatEventRoutes(testApp);
  testApp.post('/agents/orchestrator/:id', requireApiSecret, async (c) => {
    promptedAgent = true;
    assert.equal(c.req.query('wait'), 'result');

    const body = await c.req.json() as { message?: string };
    assert.match(body.message ?? '', /load_protocols/);
    assert.match(body.message ?? '', /Reply through the durable boundary/);
    assert.doesNotMatch(body.message ?? '', /durable-actor/);

    return c.json({
      result: {
        text: 'direct-agent-ok',
      },
      submission: {
        id: 'test-delivery-id',
      },
      streamUrl: c.req.url,
      offset: '0',
    });
  });

  await withApiSecret('test-secret', async () => {
    const response = await testApp.request('/api/chat/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-secret': 'test-secret',
      },
      body: JSON.stringify({
        text: 'Reply through the durable boundary.',
        actorId: 'durable-actor',
        conversationId: 'durable-conversation',
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json() as {
      result?: { text?: string };
      event?: { id?: string };
      session?: { id?: string; surface?: string; created?: boolean };
    };
    assert.equal(promptedAgent, true);
    assert.equal(body.result?.text, 'direct-agent-ok');
    assert.equal(body.session?.surface, 'web');
    assert.equal(body.session?.created, true);
    assert.equal(typeof body.session?.id, 'string');
    assert.equal(typeof body.event?.id, 'string');

    const storedEvent = goromboPersistenceRuntime.sessionDatabase.getNormalizedMessageEvent(body.event?.id ?? '');
    assert.equal(storedEvent?.text, 'Reply through the durable boundary.');
    assert.equal(storedEvent?.actor.id, 'durable-actor');
    assert.equal(storedEvent?.deliveryId, 'test-delivery-id');

    if (body.event?.id) {
      goromboPersistenceRuntime.sessionDatabase.deleteNormalizedMessageEvent(body.event.id);
    }
    if (body.session?.id) {
      goromboPersistenceRuntime.sessionDatabase.deleteChatSession(body.session.id);
    }
  });
});

test('chat event compact command compacts the durable orchestrator session without prompting', async () => {
  const testApp = new Hono();
  const requestedSessionId = `compact-direct-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let openedSessionId: string | undefined;
  let compacted = false;
  let prompted = false;

  testApp.use('/agents/*', requireApiSecret);
  registerChatEventRoutes(testApp, {
    openDurableSession: async ({ sessionId }) => {
      openedSessionId = sessionId;
      return {
        compact: async () => {
          compacted = true;
        },
        prompt: async () => {
          prompted = true;
          throw new Error('compact command should not prompt');
        },
      } as unknown as FlueSession;
    },
  });
  testApp.post('/agents/orchestrator/:id', () => {
    throw new Error('compact command should not forward to the agent prompt route');
  });

  await withApiSecret('test-secret', async () => {
    await withModelEnv(async () => {
      const response = await testApp.request('/api/chat/events', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-secret': 'test-secret',
        },
        body: JSON.stringify({
          connector: 'tui',
          text: '/compact',
          actorId: 'compact-user',
          conversationId: 'compact-thread',
          session: requestedSessionId,
        }),
      });

      assert.equal(response.status, 200);
      const body = await response.json() as {
        result?: {
          text?: string;
          command?: { name?: string; handled?: boolean };
          contextBudget?: { compactedBeforePrompt?: boolean; modelSpecifier?: string };
        };
        event?: { id?: string };
        session?: { id?: string; surface?: string; created?: boolean };
      };

      assert.equal(openedSessionId, requestedSessionId);
      assert.equal(compacted, true);
      assert.equal(prompted, false);
      assert.equal(body.result?.text, `Compacted session ${requestedSessionId}.`);
      assert.equal(body.result?.command?.name, 'compact');
      assert.equal(body.result?.command?.handled, true);
      assert.equal(body.result?.contextBudget?.compactedBeforePrompt, true);
      assert.equal(body.result?.contextBudget?.modelSpecifier, 'ollama-cloud/minimax-m3');
      assert.equal(body.session?.id, requestedSessionId);
      assert.equal(body.session?.surface, 'tui');
      assert.equal(body.session?.created, true);

      if (body.event?.id) {
        goromboPersistenceRuntime.sessionDatabase.deleteNormalizedMessageEvent(body.event.id);
      }
      goromboPersistenceRuntime.sessionDatabase.deleteChatSession(requestedSessionId);
    });
  });
});

test('telemetry run endpoint is protected and reports researcher delegation', async () => {
  flueTelemetryStore.reset();

  try {
    flueTelemetryStore.record(
      createEvent({
        type: 'task_start',
        runId: 'agent:orchestrator:run-telemetry',
        taskId: 'task-1',
        agent: 'researcher',
      }),
    );
    flueTelemetryStore.record(
      createEvent({
        type: 'tool',
        runId: 'agent:orchestrator:run-telemetry',
        taskId: 'task-1',
        toolCallId: 'tool-1',
        toolName: 'web_research',
        isError: false,
        durationMs: 12,
      }),
    );

    await withApiSecret('test-secret', async () => {
      const unauthorized = await app.request('/api/telemetry/runs/agent%3Aorchestrator%3Arun-telemetry');
      assert.equal(unauthorized.status, 401);

      const response = await app.request('/api/telemetry/runs/agent%3Aorchestrator%3Arun-telemetry', {
        headers: { 'x-api-secret': 'test-secret' },
      });

      assert.equal(response.status, 200);
      const body = await response.json() as {
        delegatedToResearcher?: boolean;
        calledWebResearch?: boolean;
        taskStarts?: Array<{ agent?: string }>;
        toolCalls?: Array<{ toolName?: string }>;
      };
      assert.equal(body.delegatedToResearcher, true);
      assert.equal(body.calledWebResearch, true);
      assert.equal(body.taskStarts?.[0]?.agent, 'researcher');
      assert.equal(body.toolCalls?.[0]?.toolName, 'web_research');
    });
  } finally {
    flueTelemetryStore.reset();
  }
});

test('telemetry run endpoint falls back to persisted Flue run events after memory miss', async () => {
  const testApp = new Hono();
  testApp.get('/runs/:runId', requireApiSecret, (c) => c.json([
    {
      type: 'run_start',
      runId: c.req.param('runId'),
      payload: { text: 'do not expose prompt text' },
    },
    {
      type: 'task_start',
      runId: c.req.param('runId'),
      taskId: 'task-1',
      agent: 'researcher',
    },
    {
      type: 'tool',
      runId: c.req.param('runId'),
      taskId: 'task-1',
      toolName: 'web_research',
      isError: false,
      durationMs: 12,
    },
    {
      type: 'run_end',
      runId: c.req.param('runId'),
      result: { text: 'do not expose final text' },
    },
  ]));
  registerTelemetryRoutes(testApp);

  flueTelemetryStore.reset();

  try {
    await withApiSecret('test-secret', async () => {
      const unauthorized = await testApp.request('/api/telemetry/runs/agent%3Aorchestrator%3Apersisted-run');
      assert.equal(unauthorized.status, 401);

      const response = await testApp.request('/api/telemetry/runs/agent%3Aorchestrator%3Apersisted-run', {
        headers: { 'x-api-secret': 'test-secret' },
      });

      assert.equal(response.status, 200);
      const body = await response.json() as {
        eventCount?: number;
        delegatedToResearcher?: boolean;
        calledWebResearch?: boolean;
        events?: Array<Record<string, unknown>>;
      };
      assert.equal(body.eventCount, 4);
      assert.equal(body.delegatedToResearcher, true);
      assert.equal(body.calledWebResearch, true);
      assert.equal(body.events?.some((event) => 'payload' in event || 'result' in event), false);
    });
  } finally {
    flueTelemetryStore.reset();
  }
});

test('telemetry run endpoint treats non-JSON persisted run responses as not found', async () => {
  const testApp = new Hono();
  testApp.get('/runs/:runId', requireApiSecret, (c) => c.text('not json'));
  registerTelemetryRoutes(testApp);
  flueTelemetryStore.reset();

  await withApiSecret('test-secret', async () => {
    const response = await testApp.request('/api/telemetry/runs/agent%3Aorchestrator%3Anon-json-run', {
      headers: { 'x-api-secret': 'test-secret' },
    });

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: 'Telemetry run not found',
      runId: 'agent:orchestrator:non-json-run',
    });
  });
});

async function withApiSecret(secret: string | undefined, fn: () => Promise<void>): Promise<void> {
  const previous = process.env.API_SECRET;

  try {
    if (secret === undefined) {
      delete process.env.API_SECRET;
    } else {
      process.env.API_SECRET = secret;
    }

    await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.API_SECRET;
    } else {
      process.env.API_SECRET = previous;
    }
  }
}

async function withModelEnv(fn: () => Promise<void>): Promise<void> {
  const previous = {
    OLLAMA_API_KEY: process.env.OLLAMA_API_KEY,
    CODEX_BRAIN_LOCAL_API_KEY: process.env.CODEX_BRAIN_LOCAL_API_KEY,
    CODEX_BRAIN_LOCAL_API_URL: process.env.CODEX_BRAIN_LOCAL_API_URL,
  };

  try {
    process.env.OLLAMA_API_KEY = 'test-key';
    process.env.CODEX_BRAIN_LOCAL_API_KEY = 'test-key';
    process.env.CODEX_BRAIN_LOCAL_API_URL = 'https://dt1.example.test/v1';
    await fn();
  } finally {
    restoreEnv('OLLAMA_API_KEY', previous.OLLAMA_API_KEY);
    restoreEnv('CODEX_BRAIN_LOCAL_API_KEY', previous.CODEX_BRAIN_LOCAL_API_KEY);
    restoreEnv('CODEX_BRAIN_LOCAL_API_URL', previous.CODEX_BRAIN_LOCAL_API_URL);
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function createEvent(input: Record<string, unknown>): FlueEvent {
  return input as unknown as FlueEvent;
}
