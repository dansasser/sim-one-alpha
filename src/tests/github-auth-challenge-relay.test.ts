import assert from 'node:assert/strict';
import test from 'node:test';
import {
  InMemoryGithubAuthChallengeRelay,
} from '../api/ingress/github-auth-challenge-relay.js';

const audience = {
  connector: 'web-api',
  actorId: 'actor-1',
  conversationId: 'conversation-1',
  eventId: 'event-1',
};

test('GitHub auth challenge relay delivers a one-time code only to its initiating audience', () => {
  const relay = new InMemoryGithubAuthChallengeRelay();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  relay.deliver({
    sessionId: 'session-1',
    audience,
    verificationUri: 'https://github.com/login/device',
    userCode: 'WXYZ-1234',
    expiresAt,
  });

  assert.equal(relay.consume({ ...audience, actorId: 'other-actor' }), undefined);
  assert.deepEqual(relay.consume(audience), {
    sessionId: 'session-1',
    verificationUri: 'https://github.com/login/device',
    userCode: 'WXYZ-1234',
    expiresAt,
  });
  assert.equal(relay.consume(audience), undefined);
});

test('GitHub auth challenge relay rejects malformed expiry timestamps', () => {
  const relay = new InMemoryGithubAuthChallengeRelay();
  relay.deliver({
    sessionId: 'session-malformed-expiry',
    audience,
    verificationUri: 'https://github.com/login/device',
    userCode: 'BADT-IME1',
    expiresAt: 'not-a-timestamp',
  });

  assert.equal(relay.consume(audience), undefined);
});

test('GitHub auth challenge relay drops expired challenges and permits a fresh replacement', () => {
  const relay = new InMemoryGithubAuthChallengeRelay();
  relay.deliver({
    sessionId: 'session-expired',
    audience,
    verificationUri: 'https://github.com/login/device',
    userCode: 'OLDX-0001',
    expiresAt: '2000-01-01T00:00:00.000Z',
  });

  assert.equal(relay.consume(audience), undefined);

  const futureExpiry = new Date(Date.now() + 60_000).toISOString();
  relay.deliver({
    sessionId: 'session-replacement',
    audience,
    verificationUri: 'https://github.com/login/device',
    userCode: 'NEWX-0002',
    expiresAt: futureExpiry,
  });

  assert.deepEqual(relay.consume(audience), {
    sessionId: 'session-replacement',
    verificationUri: 'https://github.com/login/device',
    userCode: 'NEWX-0002',
    expiresAt: futureExpiry,
  });
});

test('GitHub auth challenge relay delivers an approved challenge on a later event in the same conversation', () => {
  const relay = new InMemoryGithubAuthChallengeRelay();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  relay.deliver({
    sessionId: 'session-continuation',
    audience,
    verificationUri: 'https://github.com/login/device',
    userCode: 'NEXT-0001',
    expiresAt,
  });

  assert.deepEqual(relay.consume({ ...audience, eventId: 'event-2' }), {
    sessionId: 'session-continuation',
    verificationUri: 'https://github.com/login/device',
    userCode: 'NEXT-0001',
    expiresAt,
  });
});

test('an older expiry timer cannot delete a newer challenge for the same event', async () => {
  const relay = new InMemoryGithubAuthChallengeRelay();
  relay.deliver({
    sessionId: 'session-old-timer',
    audience,
    verificationUri: 'https://github.com/login/device',
    userCode: 'OLDT-0001',
    expiresAt: new Date(Date.now() + 10).toISOString(),
  });
  const replacementExpiry = new Date(Date.now() + 60_000).toISOString();
  relay.deliver({
    sessionId: 'session-new-timer',
    audience,
    verificationUri: 'https://github.com/login/device',
    userCode: 'NEWT-0002',
    expiresAt: replacementExpiry,
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(relay.consume(audience), {
    sessionId: 'session-new-timer',
    verificationUri: 'https://github.com/login/device',
    userCode: 'NEWT-0002',
    expiresAt: replacementExpiry,
  });
});

test('a late expired challenge cannot remove a newer challenge for the same event', () => {
  const relay = new InMemoryGithubAuthChallengeRelay();
  const replacementExpiry = new Date(Date.now() + 60_000).toISOString();
  relay.deliver({
    sessionId: 'session-current',
    audience,
    verificationUri: 'https://github.com/login/device',
    userCode: 'CURR-0001',
    expiresAt: replacementExpiry,
  });
  relay.deliver({
    sessionId: 'session-late-expired',
    audience,
    verificationUri: 'https://github.com/login/device',
    userCode: 'LATE-0002',
    expiresAt: '2000-01-01T00:00:00.000Z',
  });

  assert.deepEqual(relay.consume(audience), {
    sessionId: 'session-current',
    verificationUri: 'https://github.com/login/device',
    userCode: 'CURR-0001',
    expiresAt: replacementExpiry,
  });
});
