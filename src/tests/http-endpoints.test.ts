import assert from 'node:assert/strict';
import test from 'node:test';
import type { FlueEvent } from '@flue/runtime';
import app from '../app.js';
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
