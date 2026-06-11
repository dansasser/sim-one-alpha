import assert from 'node:assert/strict';
import test from 'node:test';
import type { FlueEvent } from '@flue/runtime';
import { Hono } from 'hono';
import app from '../app.js';
import { requireApiSecret } from '../middleware/api-secret.js';
import { registerTelemetryRoutes } from '../routes/telemetry.js';
import { flueTelemetryStore } from '../telemetry/flue-telemetry.js';

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

test('telemetry run endpoint is protected and reports researcher delegation', async () => {
  flueTelemetryStore.reset();

  try {
    flueTelemetryStore.record(
      createEvent({
        type: 'task_start',
        runId: 'workflow:chat:run-telemetry',
        taskId: 'task-1',
        agent: 'researcher',
      }),
    );
    flueTelemetryStore.record(
      createEvent({
        type: 'tool_call',
        runId: 'workflow:chat:run-telemetry',
        taskId: 'task-1',
        toolCallId: 'tool-1',
        toolName: 'web_research',
        isError: false,
        durationMs: 12,
      }),
    );

    await withApiSecret('test-secret', async () => {
      const unauthorized = await app.request('/api/telemetry/runs/workflow%3Achat%3Arun-telemetry');
      assert.equal(unauthorized.status, 401);

      const response = await app.request('/api/telemetry/runs/workflow%3Achat%3Arun-telemetry', {
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
      type: 'tool_call',
      runId: c.req.param('runId'),
      taskId: 'task-1',
      toolName: 'web_research',
      result: { text: 'do not expose tool result' },
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
      const unauthorized = await testApp.request('/api/telemetry/runs/workflow%3Achat%3Apersisted-run');
      assert.equal(unauthorized.status, 401);

      const response = await testApp.request('/api/telemetry/runs/workflow%3Achat%3Apersisted-run', {
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

  await withApiSecret('test-secret', async () => {
    const response = await testApp.request('/api/telemetry/runs/workflow%3Achat%3Anon-json-run', {
      headers: { 'x-api-secret': 'test-secret' },
    });

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: 'Telemetry run not found',
      runId: 'workflow:chat:non-json-run',
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

function createEvent(input: Record<string, unknown>): FlueEvent {
  return input as unknown as FlueEvent;
}
