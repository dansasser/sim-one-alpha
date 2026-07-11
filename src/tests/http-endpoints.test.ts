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
import { isSupportedSlashCommand, parseSlashCommand } from '../engine/commands/slash-commands.js';

test('slash command parser supports session management commands', () => {
  const resume = parseSlashCommand('/resume tui-abc123');
  assert.deepEqual(resume, {
    raw: '/resume tui-abc123',
    name: 'resume',
    args: 'tui-abc123',
  });
  assert.equal(resume ? isSupportedSlashCommand(resume) : false, true);

  const rename = parseSlashCommand('/rename Release polish');
  assert.deepEqual(rename, {
    raw: '/rename Release polish',
    name: 'rename',
    args: 'Release polish',
  });
  assert.equal(rename ? isSupportedSlashCommand(rename) : false, true);

  const session = parseSlashCommand('/session');
  assert.deepEqual(session, {
    raw: '/session',
    name: 'session',
    args: '',
  });
  assert.equal(session ? isSupportedSlashCommand(session) : false, true);

  const clear = parseSlashCommand('/clear');
  assert.deepEqual(clear, {
    raw: '/clear',
    name: 'clear',
    args: '',
  });
  assert.equal(clear ? isSupportedSlashCommand(clear) : false, true);
});

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
      session?: { id?: string; surface?: string; created?: boolean; title?: string };
    };
    assert.equal(promptedAgent, true);
    assert.equal(body.result?.text, 'direct-agent-ok');
    assert.equal(body.session?.surface, 'web');
    assert.equal(body.session?.created, true);
    assert.equal(body.session?.title, undefined);
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
        session?: { id?: string; surface?: string; created?: boolean; title?: string };
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

test('chat event TUI session commands create resume and rename without prompting', async () => {
  const testApp = new Hono();
  const actorId = `session-user-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const conversationId = `session-thread-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const eventIds: string[] = [];
  let sessionId: string | undefined;

  testApp.use('/agents/*', requireApiSecret);
  registerChatEventRoutes(testApp);
  testApp.post('/agents/orchestrator/:id', () => {
    throw new Error('session commands should not forward to the agent prompt route');
  });

  try {
    await withApiSecret('test-secret', async () => {
      const createResponse = await testApp.request('/api/chat/events', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-secret': 'test-secret',
        },
        body: JSON.stringify({
          connector: 'tui',
          text: '/new Release testing',
          actorId,
          conversationId,
        }),
      });
      assert.equal(createResponse.status, 200);
      const createBody = await createResponse.json() as {
        result?: { command?: { name?: string }; text?: string };
        event?: { id?: string };
        session?: { id?: string; surface?: string; created?: boolean; title?: string };
      };
      if (createBody.event?.id) eventIds.push(createBody.event.id);
      sessionId = createBody.session?.id;
      assert.equal(createBody.result?.command?.name, 'new');
      assert.match(createBody.result?.text ?? '', /Started new session tui-/);
      assert.equal(typeof sessionId, 'string');
      assert.equal(createBody.session?.surface, 'tui');
      assert.equal(createBody.session?.created, true);
      assert.equal(createBody.session?.title, 'Release testing');

      const resumeResponse = await testApp.request('/api/chat/events', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-secret': 'test-secret',
        },
        body: JSON.stringify({
          connector: 'tui',
          text: `/resume ${sessionId}`,
          actorId,
          conversationId,
        }),
      });
      assert.equal(resumeResponse.status, 200);
      const resumeBody = await resumeResponse.json() as {
        result?: { command?: { name?: string }; text?: string };
        event?: { id?: string };
        session?: { id?: string; surface?: string; created?: boolean };
      };
      if (resumeBody.event?.id) eventIds.push(resumeBody.event.id);
      assert.equal(resumeBody.result?.command?.name, 'resume');
      assert.equal(resumeBody.result?.text, `Resumed session ${sessionId}.`);
      assert.equal(resumeBody.session?.id, sessionId);
      assert.equal(resumeBody.session?.created, false);

      const renameResponse = await testApp.request('/api/chat/events', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-secret': 'test-secret',
        },
        body: JSON.stringify({
          connector: 'tui',
          text: '/rename Demo Session',
          actorId,
          conversationId,
          session: sessionId,
        }),
      });
      assert.equal(renameResponse.status, 200);
      const renameBody = await renameResponse.json() as {
        result?: { command?: { name?: string }; text?: string };
        event?: { id?: string };
        session?: { id?: string; title?: string };
      };
      if (renameBody.event?.id) eventIds.push(renameBody.event.id);
      assert.equal(renameBody.result?.command?.name, 'rename');
      assert.equal(renameBody.result?.text, `Renamed session ${sessionId} to "Demo Session".`);
      assert.equal(renameBody.session?.id, sessionId);
      assert.equal(renameBody.session?.title, 'Demo Session');

      const storedSession = goromboPersistenceRuntime.sessionDatabase.getChatSession(sessionId ?? '');
      assert.equal(storedSession?.title, 'Demo Session');
    });
  } finally {
    for (const eventId of eventIds) {
      goromboPersistenceRuntime.sessionDatabase.deleteNormalizedMessageEvent(eventId);
    }
    if (sessionId) {
      goromboPersistenceRuntime.sessionDatabase.deleteChatSession(sessionId);
    }
  }
});

test('chat event TUI resolves one active session per connector scope without primary', async () => {
  const testApp = new Hono();
  const actorId = `active-tui-user-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const conversationId = `active-tui-thread-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const eventIds: string[] = [];
  const sessionIds: string[] = [];

  testApp.use('/agents/*', requireApiSecret);
  registerChatEventRoutes(testApp);
  testApp.post('/agents/orchestrator/:id', () => {
    throw new Error('session resolution commands should not forward to the agent prompt route');
  });

  try {
    await withApiSecret('test-secret', async () => {
      const first = await postChat(testApp, {
        connector: 'tui',
        text: '/session',
        actorId,
        conversationId,
      });
      assert.equal(first.status, 200);
      const firstBody = await first.json() as CommandSessionBody;
      if (firstBody.event?.id) eventIds.push(firstBody.event.id);
      if (firstBody.session?.id) sessionIds.push(firstBody.session.id);
      assert.equal(firstBody.result?.command?.name, 'session');
      assert.equal(firstBody.session?.surface, 'tui');
      assert.equal(firstBody.session?.created, true);
      assert.match(firstBody.session?.id ?? '', /^tui-/);

      const second = await postChat(testApp, {
        connector: 'tui',
        text: '/session',
        actorId,
        conversationId,
      });
      assert.equal(second.status, 200);
      const secondBody = await second.json() as CommandSessionBody;
      if (secondBody.event?.id) eventIds.push(secondBody.event.id);
      assert.equal(secondBody.result?.command?.name, 'session');
      assert.equal(secondBody.session?.id, firstBody.session?.id);
      assert.equal(secondBody.session?.created, false);

      const cleared = await postChat(testApp, {
        connector: 'tui',
        text: '/clear',
        actorId,
        conversationId,
      });
      assert.equal(cleared.status, 200);
      const clearBody = await cleared.json() as CommandSessionBody;
      if (clearBody.event?.id) eventIds.push(clearBody.event.id);
      if (clearBody.session?.id) sessionIds.push(clearBody.session.id);
      assert.equal(clearBody.result?.command?.name, 'clear');
      assert.equal(clearBody.session?.surface, 'tui');
      assert.equal(clearBody.session?.created, true);
      assert.notEqual(clearBody.session?.id, firstBody.session?.id);

      const afterClear = await postChat(testApp, {
        connector: 'tui',
        text: '/session',
        actorId,
        conversationId,
      });
      assert.equal(afterClear.status, 200);
      const afterClearBody = await afterClear.json() as CommandSessionBody;
      if (afterClearBody.event?.id) eventIds.push(afterClearBody.event.id);
      assert.equal(afterClearBody.session?.id, clearBody.session?.id);
      assert.equal(afterClearBody.session?.created, false);
    });
  } finally {
    for (const eventId of eventIds) {
      goromboPersistenceRuntime.sessionDatabase.deleteNormalizedMessageEvent(eventId);
    }
    for (const sessionId of sessionIds) {
      goromboPersistenceRuntime.sessionDatabase.deleteChatSession(sessionId);
    }
  }
});

test('chat event TUI resume denies sessions from another actor', async () => {
  const testApp = new Hono();
  const ownerActorId = `resume-owner-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ownerConversationId = `resume-owner-thread-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const otherActorId = `resume-other-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let sessionId: string | undefined;
  const eventIds: string[] = [];

  testApp.use('/agents/*', requireApiSecret);
  registerChatEventRoutes(testApp);
  testApp.post('/agents/orchestrator/:id', () => {
    throw new Error('resume command should not forward to the agent prompt route');
  });

  try {
    await withApiSecret('test-secret', async () => {
      const createResponse = await testApp.request('/api/chat/events', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-secret': 'test-secret',
        },
        body: JSON.stringify({
          connector: 'tui',
          text: '/new Owner Session',
          actorId: ownerActorId,
          conversationId: ownerConversationId,
        }),
      });
      assert.equal(createResponse.status, 200);
      const createBody = await createResponse.json() as {
        event?: { id?: string };
        session?: { id?: string };
      };
      if (createBody.event?.id) eventIds.push(createBody.event.id);
      sessionId = createBody.session?.id;
      assert.equal(typeof sessionId, 'string');

      const deniedResponse = await testApp.request('/api/chat/events', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-secret': 'test-secret',
        },
        body: JSON.stringify({
          connector: 'tui',
          text: `/resume ${sessionId}`,
          actorId: otherActorId,
          conversationId: ownerConversationId,
        }),
      });
      assert.equal(deniedResponse.status, 403);
      const deniedBody = await deniedResponse.json() as { error?: string; eventId?: string };
      if (deniedBody.eventId) eventIds.push(deniedBody.eventId);
      assert.match(deniedBody.error ?? '', /not available/);
    });
  } finally {
    for (const eventId of eventIds) {
      goromboPersistenceRuntime.sessionDatabase.deleteNormalizedMessageEvent(eventId);
    }
    if (sessionId) {
      goromboPersistenceRuntime.sessionDatabase.deleteChatSession(sessionId);
    }
  }
});

test('chat event TUI resume and rename commands validate required arguments', async () => {
  const testApp = new Hono();
  const actorId = `usage-user-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const conversationId = `usage-thread-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const eventIds: string[] = [];

  testApp.use('/agents/*', requireApiSecret);
  registerChatEventRoutes(testApp);
  testApp.post('/agents/orchestrator/:id', () => {
    throw new Error('invalid session commands should not forward to the agent prompt route');
  });

  try {
    await withApiSecret('test-secret', async () => {
      const resumeResponse = await testApp.request('/api/chat/events', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-secret': 'test-secret',
        },
        body: JSON.stringify({
          connector: 'tui',
          text: '/resume',
          actorId,
          conversationId,
        }),
      });
      assert.equal(resumeResponse.status, 400);
      const resumeBody = await resumeResponse.json() as {
        result?: { text?: string; command?: { name?: string } };
        event?: { id?: string };
      };
      if (resumeBody.event?.id) eventIds.push(resumeBody.event.id);
      assert.equal(resumeBody.result?.command?.name, 'resume');
      assert.equal(resumeBody.result?.text, 'Usage: /resume <session-id>');

      const renameResponse = await testApp.request('/api/chat/events', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-secret': 'test-secret',
        },
        body: JSON.stringify({
          connector: 'tui',
          text: '/rename',
          actorId,
          conversationId,
        }),
      });
      assert.equal(renameResponse.status, 400);
      const renameBody = await renameResponse.json() as {
        result?: { text?: string; command?: { name?: string } };
        event?: { id?: string };
        session?: { id?: string };
      };
      if (renameBody.event?.id) eventIds.push(renameBody.event.id);
      assert.equal(renameBody.result?.command?.name, 'rename');
      assert.equal(renameBody.result?.text, 'Usage: /rename <title>');
      if (renameBody.session?.id) {
        goromboPersistenceRuntime.sessionDatabase.deleteChatSession(renameBody.session.id);
      }
    });
  } finally {
    for (const eventId of eventIds) {
      goromboPersistenceRuntime.sessionDatabase.deleteNormalizedMessageEvent(eventId);
    }
  }
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

interface CommandSessionBody {
  result?: { command?: { name?: string }; text?: string };
  event?: { id?: string };
  session?: { id?: string; surface?: string; created?: boolean };
}

async function postChat(testApp: Hono, body: Record<string, unknown>): Promise<Response> {
  return await testApp.request('/api/chat/events', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-secret': 'test-secret',
    },
    body: JSON.stringify(body),
  });
}

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
