import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { goromboPersistenceRuntime } from '../db.js';
import type { ConnectorKind, NormalizedMessageEvent } from '../core/types/index.js';
import {
  GoromboSessionDatabase,
  type ChatSessionRecord,
} from '../engine/session/session-database.js';
import {
  ChatSessionAmbiguousError,
  ChatSessionNotFoundError,
  connectorUsesPersistentSession,
  createFreshChatSession,
  listOwnedChatSessions,
  resolveChatSession,
  resumeOwnedChatSession,
  SessionAccessDeniedError,
  type ChatSessionIdentity,
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

test('web API clients can establish and then reuse an explicit session id', () => {
  const scope = uniqueScope('web-explicit');
  const sessionId = `web-client-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  try {
    const first = resolveChatSession({
      event: createEvent('web-api', scope),
      requestedSessionId: sessionId,
    });
    const second = resolveChatSession({
      event: createEvent('web-api', scope),
      requestedSessionId: sessionId,
    });

    assert.equal(first.created, true);
    assert.equal(first.sessionId, sessionId);
    assert.equal(second.created, false);
    assert.equal(second.sessionId, sessionId);
  } finally {
    deleteSessions([sessionId]);
  }
});

test('TUI explicit session ids remain resume-only', () => {
  const scope = uniqueScope('tui-explicit-missing');
  const sessionId = `tui-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  assert.throws(
    () => resolveChatSession({
      event: createEvent('tui', scope),
      requestedSessionId: sessionId,
    }),
    ChatSessionNotFoundError,
  );
  assert.equal(goromboPersistenceRuntime.sessionDatabase.getChatSession(sessionId), null);
});

test('fresh lifecycle creation returns distinct TUI sessions for one identity', () => {
  const identity = uniqueIdentity('tui', 'lifecycle-fresh');
  const sessionIds: string[] = [];

  try {
    const first = createFreshChatSession({ identity });
    const second = createFreshChatSession({ identity });
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

test('owned lifecycle resume returns the requested session without recreating it', () => {
  const identity = uniqueIdentity('tui', 'lifecycle-resume');
  const created = createFreshChatSession({
    identity,
    title: 'Resume title',
    displayName: 'Resume name',
  });

  try {
    const resumed = resumeOwnedChatSession({ identity, sessionId: created.sessionId });

    assert.equal(resumed.sessionId, created.sessionId);
    assert.equal(resumed.created, false);
    assert.equal(resumed.session.displayName, 'Resume name');
  } finally {
    deleteSessions([created.sessionId]);
  }
});

test('owned lifecycle resume moves the session to the front of recent sessions', () => {
  const identity = uniqueIdentity('tui', 'lifecycle-resume-recency');
  const first = createFreshChatSession({ identity, displayName: 'Older session' });
  sleepForTimestampChange();
  const second = createFreshChatSession({ identity, displayName: 'Newer session' });

  try {
    assert.equal(listOwnedChatSessions({ identity, limit: 10 })[0]?.sessionId, second.sessionId);
    sleepForTimestampChange();

    const resumed = resumeOwnedChatSession({ identity, sessionId: first.sessionId });
    const listed = listOwnedChatSessions({ identity, limit: 10 });

    assert.equal(resumed.session.updatedAt, listed[0]?.updatedAt);
    assert.equal(listed[0]?.sessionId, first.sessionId);
  } finally {
    deleteSessions([first.sessionId, second.sessionId]);
  }
});

test('owned lifecycle resume resolves an explicit session name to its canonical id', () => {
  const identity = uniqueIdentity('tui', 'lifecycle-name-resume');
  const created = createFreshChatSession({
    identity,
    displayName: 'Named lifecycle session',
  });

  try {
    const resumed = resumeOwnedChatSession({
      identity,
      sessionId: 'Named lifecycle session',
    });

    assert.equal(resumed.sessionId, created.sessionId);
    assert.equal(resumed.created, false);
    assert.equal(resumed.session.displayName, 'Named lifecycle session');
  } finally {
    deleteSessions([created.sessionId]);
  }
});

test('owned lifecycle resume rejects duplicate explicit names in one scope', () => {
  const identity = uniqueIdentity('tui', 'lifecycle-name-ambiguous');
  const first = createFreshChatSession({ identity, displayName: 'Duplicate name' });
  const second = createFreshChatSession({ identity, displayName: 'Duplicate name' });

  try {
    assert.throws(
      () => resumeOwnedChatSession({ identity, sessionId: 'Duplicate name' }),
      ChatSessionAmbiguousError,
    );
  } finally {
    deleteSessions([first.sessionId, second.sessionId]);
  }
});

test('owned lifecycle resume rejects another actor or conversation', () => {
  const identity = uniqueIdentity('tui', 'lifecycle-denied');
  const created = createFreshChatSession({ identity });

  try {
    assert.throws(
      () => resumeOwnedChatSession({
        identity: { ...identity, actorId: `${identity.actorId}-other` },
        sessionId: created.sessionId,
      }),
      SessionAccessDeniedError,
    );
    assert.throws(
      () => resumeOwnedChatSession({
        identity: { ...identity, conversationId: `${identity.conversationId}-other` },
        sessionId: created.sessionId,
      }),
      SessionAccessDeniedError,
    );
  } finally {
    deleteSessions([created.sessionId]);
  }
});

test('owned lifecycle resume rejects an unknown id without creating a row', () => {
  const identity = uniqueIdentity('tui', 'lifecycle-missing');
  const sessionId = `tui-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  assert.throws(
    () => resumeOwnedChatSession({ identity, sessionId }),
    ChatSessionNotFoundError,
  );
  assert.equal(goromboPersistenceRuntime.sessionDatabase.getChatSession(sessionId), null);
});

test('owned lifecycle listing is isolated by surface and full conversation scope', () => {
  const identity = uniqueIdentity('tui', 'lifecycle-list');
  const otherIdentity = { ...identity, actorId: `${identity.actorId}-other` };
  const telegramIdentity = uniqueIdentity('telegram', 'lifecycle-list-telegram');
  const sessions = [
    createFreshChatSession({ identity, displayName: 'Owned first' }),
    createFreshChatSession({ identity, displayName: 'Owned second' }),
    createFreshChatSession({ identity: otherIdentity, displayName: 'Other actor' }),
    createFreshChatSession({ identity: telegramIdentity, displayName: 'Telegram' }),
  ];

  try {
    const listed = listOwnedChatSessions({ identity, limit: 10 });
    const listedIds = new Set(listed.map((session: ChatSessionRecord) => session.sessionId));

    assert.equal(listedIds.has(sessions[0].sessionId), true);
    assert.equal(listedIds.has(sessions[1].sessionId), true);
    assert.equal(listedIds.has(sessions[2].sessionId), false);
    assert.equal(listedIds.has(sessions[3].sessionId), false);
  } finally {
    deleteSessions(sessions.map((session) => session.sessionId));
  }
});

test('database migration removes obsolete TUI active pointers without deleting sessions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sim-one-session-routing-'));
  const databasePath = join(directory, 'sessions.sqlite');
  const identity = uniqueIdentity('tui', 'migration');
  let sessionId = '';

  try {
    const firstDatabase = new GoromboSessionDatabase(databasePath);
    const session = firstDatabase.createChatSession({
      origin: 'tui',
      actorId: identity.actorId,
      conversationId: identity.conversationId,
      threadId: identity.threadId,
    });
    sessionId = session.sessionId;
    firstDatabase.setActiveSession({
      surface: 'tui',
      connector: 'tui',
      actorId: identity.actorId,
      conversationId: identity.conversationId,
      threadId: identity.threadId,
      sessionId,
    });
    assert.equal(firstDatabase.getActiveSession({
      surface: 'tui',
      connector: 'tui',
      actorId: identity.actorId,
      conversationId: identity.conversationId,
      threadId: identity.threadId,
    }), sessionId);
    firstDatabase.close();

    const reopenedDatabase = new GoromboSessionDatabase(databasePath);
    assert.equal(reopenedDatabase.getActiveSession({
      surface: 'tui',
      connector: 'tui',
      actorId: identity.actorId,
      conversationId: identity.conversationId,
      threadId: identity.threadId,
    }), null);
    assert.equal(reopenedDatabase.getChatSession(sessionId)?.sessionId, sessionId);
    reopenedDatabase.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
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

function uniqueIdentity(connector: ConnectorKind, prefix: string): ChatSessionIdentity {
  const scope = uniqueScope(prefix);
  return {
    connector,
    actorId: scope.actorId,
    conversationId: scope.conversationId,
    threadId: scope.threadId,
  };
}

function deleteSessions(sessionIds: string[]): void {
  for (const sessionId of new Set(sessionIds)) {
    goromboPersistenceRuntime.sessionDatabase.deleteChatSession(sessionId);
  }
}

function sleepForTimestampChange(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
}
