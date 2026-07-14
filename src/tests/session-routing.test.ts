import assert from 'node:assert/strict';
import test from 'node:test';
import { goromboPersistenceRuntime } from '../db.js';
import type { ConnectorKind, NormalizedMessageEvent } from '../core/types/index.js';
import {
  connectorUsesPersistentSession,
  resolveChatSession,
} from '../engine/session/session-routing.js';

test('only Telegram uses connector-scoped persistent sessions', () => {
  assert.equal(connectorUsesPersistentSession('telegram'), true);
  assert.equal(connectorUsesPersistentSession('tui'), false);
  assert.equal(connectorUsesPersistentSession('web-api'), false);
  assert.equal(connectorUsesPersistentSession('scheduled-job'), false);
  assert.equal(connectorUsesPersistentSession('test'), false);
  assert.equal(connectorUsesPersistentSession('unknown'), false);
});

test('TUI resolutions without an explicit session always create fresh sessions', () => {
  const scope = uniqueScope('tui-fresh');
  const sessionIds: string[] = [];

  try {
    const first = resolveChatSession({ event: createEvent('tui', scope) });
    const second = resolveChatSession({ event: createEvent('tui', scope) });
    sessionIds.push(first.sessionId, second.sessionId);

    assert.equal(first.created, true);
    assert.equal(second.created, true);
    assert.match(first.sessionId, /^tui-/);
    assert.match(second.sessionId, /^tui-/);
    assert.notEqual(second.sessionId, first.sessionId);
  } finally {
    deleteSessions(sessionIds);
  }
});

test('Telegram resolutions reuse the active session for one conversation', () => {
  const scope = uniqueScope('telegram-persistent');
  const sessionIds: string[] = [];

  try {
    const first = resolveChatSession({ event: createEvent('telegram', scope) });
    const second = resolveChatSession({ event: createEvent('telegram', scope) });
    sessionIds.push(first.sessionId, second.sessionId);

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.sessionId, first.sessionId);
  } finally {
    deleteSessions(sessionIds);
  }
});

test('scheduled-job resolutions do not inherit connector persistence', () => {
  const scope = uniqueScope('scheduled-fresh');
  const sessionIds: string[] = [];

  try {
    const first = resolveChatSession({ event: createEvent('scheduled-job', scope) });
    const second = resolveChatSession({ event: createEvent('scheduled-job', scope) });
    sessionIds.push(first.sessionId, second.sessionId);

    assert.equal(first.created, true);
    assert.equal(second.created, true);
    assert.notEqual(second.sessionId, first.sessionId);
  } finally {
    deleteSessions(sessionIds);
  }
});

interface TestScope {
  actorId: string;
  conversationId: string;
  threadId: string;
}

function uniqueScope(prefix: string): TestScope {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return {
    actorId: `${prefix}-actor-${suffix}`,
    conversationId: `${prefix}-conversation-${suffix}`,
    threadId: `${prefix}-thread-${suffix}`,
  };
}

function createEvent(connector: ConnectorKind, scope: TestScope): NormalizedMessageEvent {
  return {
    id: `${connector}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    connector,
    kind: 'chat.message',
    text: `session routing test for ${connector}`,
    receivedAt: new Date().toISOString(),
    actor: { id: scope.actorId },
    conversation: {
      id: scope.conversationId,
      threadId: scope.threadId,
    },
  };
}

function deleteSessions(sessionIds: string[]): void {
  for (const sessionId of new Set(sessionIds)) {
    goromboPersistenceRuntime.sessionDatabase.deleteChatSession(sessionId);
  }
}
