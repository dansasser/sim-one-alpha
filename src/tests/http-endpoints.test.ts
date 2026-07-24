import assert from 'node:assert/strict';
import test from 'node:test';
import type { FlueEvent, FlueSession } from '@flue/runtime';
import { Hono } from 'hono';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import app from '../app.js';
import { goromboPersistenceRuntime } from '../db.js';
import { requireApiSecret } from '../api/middleware/api-secret.js';
import { registerChatEventRoutes } from '../api/routes/chat-events.js';
import { registerChatSessionRoutes } from '../api/routes/chat-sessions.js';
import { registerTelemetryRoutes } from '../api/routes/telemetry.js';
import { flueTelemetryStore } from '../core/telemetry/flue-telemetry.js';
import { isSupportedSlashCommand, parseSlashCommand } from '../engine/commands/slash-commands.js';
import { createFreshChatSession } from '../engine/session/session-routing.js';

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

test('chat session lifecycle endpoint requires the configured API secret', async () => {
  await withApiSecret('test-secret', async () => {
    const response = await app.request('/api/chat/sessions?connector=tui&actorId=local-tui&conversationId=local-tui');

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'Unauthorized' });
  });
});

test('chat transcript route validates canonical session ownership and pagination input', async () => {
  const testApp = new Hono();
  const actorId = `transcript-user-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const conversationId = `transcript-conversation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const identity = {
    connector: 'tui' as const,
    actorId,
    conversationId,
    threadId: 'transcript-thread',
  };
  const created = createFreshChatSession({
    identity,
    displayName: 'Transcript Test',
  });
  const calls: Array<{ sessionId: string; limit: number; before?: string }> = [];

  registerChatSessionRoutes(testApp, {
    loadTranscript: async (input) => {
      calls.push({
        sessionId: input.session.id,
        limit: input.limit,
        ...(input.before ? { before: input.before } : {}),
      });
      return {
        session: {
          id: input.session.id,
          title: input.session.title,
        },
        exchanges: [{
          id: 'submission-history',
          submissionId: 'submission-history',
          prompt: {
            id: 'prompt-history',
            text: 'Historical prompt',
            receivedAt: '2026-07-20T23:00:00.000Z',
            visibility: 'user' as const,
          },
          activities: [{
            id: 'submission-history:tool:tool-history',
            kind: 'tool' as const,
            name: 'repository_status',
            status: 'completed' as const,
            durationMs: 31,
          }],
          assistant: {
            id: 'submission-history:message:2',
            text: 'Historical response',
            completedAt: '2026-07-20T23:00:01.000Z',
          },
          status: 'completed' as const,
        }],
        stream: {
          nextOffset: '0000000000000000_0000000000000042',
          upToDate: true,
        },
        page: {
          limit: input.limit,
          hasOlder: false,
        },
      };
    },
  });

  await withApiSecret('test-secret', async () => {
    const query = new URLSearchParams({
      connector: 'tui',
      actorId,
      conversationId,
      threadId: 'transcript-thread',
      limit: '25',
    });
    const response = await testApp.request(
      `/api/chat/sessions/${encodeURIComponent(created.sessionId)}/transcript?${query}`,
      { headers: { 'x-api-secret': 'test-secret' } },
    );
    assert.equal(response.status, 200);
    const body = await response.json() as {
      session?: { id?: string; title?: string };
      exchanges?: Array<{ prompt?: { text?: string }; assistant?: { text?: string } }>;
      stream?: { nextOffset?: string };
    };
    assert.equal(body.session?.id, created.sessionId);
    assert.equal(body.session?.title, 'Transcript Test');
    assert.equal(body.exchanges?.[0]?.prompt?.text, 'Historical prompt');
    assert.equal(body.exchanges?.[0]?.assistant?.text, 'Historical response');
    assert.equal(body.stream?.nextOffset, '0000000000000000_0000000000000042');
    assert.deepEqual(calls, [{ sessionId: created.sessionId, limit: 25 }]);

    const wrongActor = new URLSearchParams(query);
    wrongActor.set('actorId', `${actorId}-other`);
    const denied = await testApp.request(
      `/api/chat/sessions/${encodeURIComponent(created.sessionId)}/transcript?${wrongActor}`,
      { headers: { 'x-api-secret': 'test-secret' } },
    );
    assert.equal(denied.status, 403);

    const missing = await testApp.request(
      `/api/chat/sessions/missing-transcript-session/transcript?${query}`,
      { headers: { 'x-api-secret': 'test-secret' } },
    );
    assert.equal(missing.status, 404);

    for (const invalidQuery of [
      new URLSearchParams({ ...Object.fromEntries(query), limit: '0' }),
      new URLSearchParams({ ...Object.fromEntries(query), limit: '101' }),
      new URLSearchParams({ ...Object.fromEntries(query), before: 'not-a-cursor' }),
    ]) {
      const invalid = await testApp.request(
        `/api/chat/sessions/${encodeURIComponent(created.sessionId)}/transcript?${invalidQuery}`,
        { headers: { 'x-api-secret': 'test-secret' } },
      );
      assert.equal(invalid.status, 400);
    }
  });

  goromboPersistenceRuntime.sessionDatabase.deleteChatSession(created.sessionId);
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
      submissionId: 'test-delivery-id',
      streamUrl: c.req.url,
      offset: '0000000000000000_0000000000000042',
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
    const storedSessionEvents = goromboPersistenceRuntime.sessionDatabase
      .listNormalizedMessageEventsForSession({ sessionId: body.session?.id ?? '' });
    assert.deepEqual(storedSessionEvents[0]?.delivery, {
      submissionId: 'test-delivery-id',
      streamUrl: 'http://localhost/agents/orchestrator/'
        + `${body.session?.id}?wait=result`,
      offset: '0000000000000000_0000000000000042',
    });

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
  const actorId = `compact-user-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const conversationId = `compact-thread-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const createdSession = createFreshChatSession({
    identity: {
      connector: 'tui',
      actorId,
      conversationId,
    },
  });
  const requestedSessionId = createdSession.sessionId;
  let eventId: string | undefined;
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

  try {
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
            actorId,
            conversationId,
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
        eventId = body.event?.id;

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
        assert.equal(body.session?.created, false);
      });
    });
  } finally {
    if (eventId) {
      goromboPersistenceRuntime.sessionDatabase.deleteNormalizedMessageEvent(eventId);
    }
    goromboPersistenceRuntime.sessionDatabase.deleteChatSession(requestedSessionId);
  }
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
        session?: { id?: string; surface?: string; created?: boolean; title?: string };
      };
      if (resumeBody.event?.id) eventIds.push(resumeBody.event.id);
      assert.equal(resumeBody.result?.command?.name, 'resume');
      assert.equal(resumeBody.result?.text, `Resumed session ${sessionId}.`);
      assert.equal(resumeBody.session?.id, sessionId);
      assert.equal(resumeBody.session?.created, false);
      assert.equal(resumeBody.session?.title, 'Release testing');

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

      const namedResumeResponse = await testApp.request('/api/chat/events', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-secret': 'test-secret',
        },
        body: JSON.stringify({
          connector: 'tui',
          text: '/resume Demo Session',
          actorId,
          conversationId,
        }),
      });
      assert.equal(namedResumeResponse.status, 200);
      const namedResumeBody = await namedResumeResponse.json() as {
        result?: { command?: { name?: string }; text?: string };
        event?: { id?: string };
        session?: { id?: string; title?: string };
      };
      if (namedResumeBody.event?.id) eventIds.push(namedResumeBody.event.id);
      assert.equal(namedResumeBody.result?.command?.name, 'resume');
      assert.equal(namedResumeBody.result?.text, `Resumed session ${sessionId}.`);
      assert.equal(namedResumeBody.session?.id, sessionId);
      assert.equal(namedResumeBody.session?.title, 'Demo Session');

      const storedSession = goromboPersistenceRuntime.sessionDatabase.getChatSession(sessionId ?? '');
      assert.equal(storedSession?.title, 'Demo Session');
      assert.equal(storedSession?.displayName, 'Demo Session');
      assert.deepEqual(
        goromboPersistenceRuntime.sessionDatabase.listNormalizedMessageEventsForSession({
          sessionId: sessionId ?? '',
          limit: 20,
        }),
        [],
        'pre-LLM session commands must not enter direct-agent transcript history',
      );
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

test('chat session lifecycle creates fresh sessions, validates resume, and scopes lists without prompting', async () => {
  const testApp = new Hono();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const actorId = `lifecycle-user-${suffix}`;
  const conversationId = `lifecycle-conversation-${suffix}`;
  const threadId = `lifecycle-thread-${suffix}`;
  const otherActorId = `${actorId}-other`;
  const sessionIds: string[] = [];
  let promptedAgent = false;

  registerChatSessionRoutes(testApp);
  testApp.post('/agents/orchestrator/:id', () => {
    promptedAgent = true;
    throw new Error('session lifecycle must not forward to the agent prompt route');
  });

  try {
    await withApiSecret('test-secret', async () => {
      const first = await postLifecycle(testApp, '/api/chat/sessions', {
        connector: 'tui',
        actorId,
        conversationId,
        threadId,
      });
      assert.equal(first.status, 201);
      const firstBody = await first.json() as LifecycleSessionBody;
      if (firstBody.session?.id) sessionIds.push(firstBody.session.id);
      assert.equal(firstBody.session?.surface, 'tui');
      assert.equal(firstBody.session?.created, true);
      assert.match(firstBody.session?.id ?? '', /^tui-/);

      const second = await postLifecycle(testApp, '/api/chat/sessions', {
        connector: 'tui',
        actorId,
        conversationId,
        threadId,
      });
      assert.equal(second.status, 201);
      const secondBody = await second.json() as LifecycleSessionBody;
      if (secondBody.session?.id) sessionIds.push(secondBody.session.id);
      assert.equal(secondBody.session?.created, true);
      assert.notEqual(secondBody.session?.id, firstBody.session?.id);

      const other = await postLifecycle(testApp, '/api/chat/sessions', {
        connector: 'tui',
        actorId: otherActorId,
        conversationId,
        threadId,
      });
      assert.equal(other.status, 201);
      const otherBody = await other.json() as LifecycleSessionBody;
      if (otherBody.session?.id) sessionIds.push(otherBody.session.id);

      const firstSessionId = firstBody.session?.id ?? '';
      const resumed = await postLifecycle(
        testApp,
        `/api/chat/sessions/${encodeURIComponent(firstSessionId)}/resume`,
        {
          connector: 'tui',
          actorId,
          conversationId,
          threadId,
        },
      );
      assert.equal(resumed.status, 200);
      const resumedBody = await resumed.json() as LifecycleSessionBody;
      assert.equal(resumedBody.session?.id, firstSessionId);
      assert.equal(resumedBody.session?.created, false);

      goromboPersistenceRuntime.sessionDatabase.renameChatSession(
        firstSessionId,
        'Lifecycle Named Session',
      );
      const resumedByName = await postLifecycle(
        testApp,
        `/api/chat/sessions/${encodeURIComponent('Lifecycle Named Session')}/resume`,
        {
          connector: 'tui',
          actorId,
          conversationId,
          threadId,
        },
      );
      assert.equal(resumedByName.status, 200);
      const resumedByNameBody = await resumedByName.json() as LifecycleSessionBody;
      assert.equal(resumedByNameBody.session?.id, firstSessionId);
      assert.equal(resumedByNameBody.session?.created, false);
      assert.equal(resumedByNameBody.session?.title, 'Lifecycle Named Session');

      goromboPersistenceRuntime.sessionDatabase.renameChatSession(
        secondBody.session?.id ?? '',
        'Lifecycle Named Session',
      );
      const ambiguousName = await postLifecycle(
        testApp,
        `/api/chat/sessions/${encodeURIComponent('Lifecycle Named Session')}/resume`,
        {
          connector: 'tui',
          actorId,
          conversationId,
          threadId,
        },
      );
      assert.equal(ambiguousName.status, 409);

      const denied = await postLifecycle(
        testApp,
        `/api/chat/sessions/${encodeURIComponent(firstSessionId)}/resume`,
        {
          connector: 'tui',
          actorId: otherActorId,
          conversationId,
          threadId,
        },
      );
      assert.equal(denied.status, 403);

      const missingSessionId = `tui-missing-${suffix}`;
      const missing = await postLifecycle(
        testApp,
        `/api/chat/sessions/${encodeURIComponent(missingSessionId)}/resume`,
        {
          connector: 'tui',
          actorId,
          conversationId,
          threadId,
        },
      );
      assert.equal(missing.status, 201);
      const missingBody = await missing.json() as LifecycleSessionBody;
      if (missingBody.session?.id) sessionIds.push(missingBody.session.id);
      assert.equal(missingBody.session?.created, true);
      assert.equal(missingBody.session?.surface, 'tui');
      assert.match(missingBody.session?.id ?? '', /^tui-/);
      assert.notEqual(missingBody.session?.id, missingSessionId);
      assert.equal(goromboPersistenceRuntime.sessionDatabase.getChatSession(missingSessionId), null);

      const telegram = createFreshChatSession({
        identity: {
          connector: 'telegram',
          actorId,
          conversationId,
          threadId,
        },
      });
      sessionIds.push(telegram.sessionId);

      const query = new URLSearchParams({
        connector: 'tui',
        actorId,
        conversationId,
        threadId,
        limit: '10',
      });
      const listed = await testApp.request(`/api/chat/sessions?${query}`, {
        headers: { 'x-api-secret': 'test-secret' },
      });
      assert.equal(listed.status, 200);
      const listedBody = await listed.json() as { sessions?: Array<{ sessionId?: string }> };
      const listedIds = new Set((listedBody.sessions ?? []).map((session) => session.sessionId));
      assert.equal(listedIds.has(firstBody.session?.id), true);
      assert.equal(listedIds.has(secondBody.session?.id), true);
      assert.equal(listedIds.has(otherBody.session?.id), false);
      assert.equal(listedIds.has(telegram.sessionId), false);

      assert.equal(promptedAgent, false);
      assert.equal(countNormalizedEventsForActors([actorId, otherActorId]), 0);
    });
  } finally {
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
      assert.equal(resumeBody.result?.text, 'Usage: /resume <session-id-or-name>');

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

interface LifecycleSessionBody {
  session?: {
    id?: string;
    surface?: string;
    created?: boolean;
    title?: string;
  };
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

async function postLifecycle(testApp: Hono, path: string, body: Record<string, unknown>): Promise<Response> {
  return await testApp.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-secret': 'test-secret',
    },
    body: JSON.stringify(body),
  });
}

function countNormalizedEventsForActors(actorIds: string[]): number {
  const databasePath = resolve(process.cwd(), goromboPersistenceRuntime.sessionDatabase.filePath);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const placeholders = actorIds.map(() => '?').join(', ');
    const row = database
      .prepare(`SELECT COUNT(*) AS count FROM normalized_message_events WHERE actor_id IN (${placeholders})`)
      .get(...actorIds) as { count: number };
    return row.count;
  } finally {
    database.close();
  }
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
