import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('trusted event admissions persist exact audience claims and expire closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'trusted-event-admission-'));
  const database = new GoromboSessionDatabase(join(root, 'sessions.sqlite'));

  try {
    database.recordNormalizedMessageEvent({ event });
    const admission = database.createTrustedEventAdmission({
      event,
      purpose: 'github.auth',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    assert.deepEqual(database.getTrustedEventAdmission(admission.id), admission);

    const expired = database.createTrustedEventAdmission({
      event,
      purpose: 'github.auth',
      expiresAt: new Date(Date.now() - 1).toISOString(),
    });
    assert.equal(database.getTrustedEventAdmission(expired.id), undefined);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
