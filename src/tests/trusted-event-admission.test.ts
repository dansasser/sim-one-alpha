import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { GoromboSessionDatabase } from '../engine/session/session-database.js';

const event = {
  id: 'telegram:admission-test',
  connector: 'telegram',
  kind: 'chat.message',
  text: 'authenticate GitHub',
  receivedAt: new Date().toISOString(),
  actor: { id: 'actor-1' },
  conversation: { id: 'conversation-1' },
} as const;

test('trusted event admissions are bound to agent and event while independent queued events remain available', () => {
  const root = mkdtempSync(join(tmpdir(), 'trusted-event-admission-'));
  const database = new GoromboSessionDatabase(join(root, 'sessions.sqlite'));

  try {
    database.recordNormalizedMessageEvent({ event });
    const admission = database.createTrustedEventAdmission({
      event,
      agentInstanceId: 'telegram-agent-session',
      purpose: 'github.auth',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    assert.deepEqual(
      database.getTrustedEventAdmissionForAgent('telegram-agent-session', event.id),
      admission,
    );
    assert.equal(
      database.getTrustedEventAdmissionForAgent('different-agent-session', event.id),
      undefined,
    );

    const queuedEvent = {
      ...event,
      id: 'telegram:admission-test-queued',
      text: 'second queued event',
    } as const;
    database.recordNormalizedMessageEvent({ event: queuedEvent });
    const queuedAdmission = database.createTrustedEventAdmission({
      event: queuedEvent,
      agentInstanceId: admission.agentInstanceId,
      purpose: 'github.auth',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    assert.deepEqual(
      database.getTrustedEventAdmissionForAgent(admission.agentInstanceId, event.id),
      admission,
    );
    assert.deepEqual(
      database.getTrustedEventAdmissionForAgent(admission.agentInstanceId, queuedEvent.id),
      queuedAdmission,
    );

    const expired = database.createTrustedEventAdmission({
      event,
      agentInstanceId: 'expired-agent-session',
      purpose: 'github.auth',
      expiresAt: new Date(Date.now() - 1).toISOString(),
    });
    assert.equal(
      database.getTrustedEventAdmissionForAgent(expired.agentInstanceId, event.id),
      undefined,
    );
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('trusted event admission schema upgrades existing databases before use', () => {
  const root = mkdtempSync(join(tmpdir(), 'trusted-event-admission-migration-'));
  const databasePath = join(root, 'sessions.sqlite');
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE trusted_event_admissions (
      admission_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      purpose TEXT NOT NULL,
      connector TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  legacy.close();

  const database = new GoromboSessionDatabase(databasePath);
  try {
    database.recordNormalizedMessageEvent({ event });
    const admission = database.createTrustedEventAdmission({
      event,
      agentInstanceId: 'migrated-agent-session',
      purpose: 'github.auth',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    assert.deepEqual(
      database.getTrustedEventAdmissionForAgent(admission.agentInstanceId, event.id),
      admission,
    );
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
