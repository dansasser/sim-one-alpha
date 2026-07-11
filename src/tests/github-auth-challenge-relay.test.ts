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
  relay.deliver({
    sessionId: 'session-1',
    audience,
    verificationUri: 'https://github.com/login/device',
    userCode: 'WXYZ-1234',
    expiresAt: '2030-01-01T00:00:00.000Z',
  });

  assert.equal(relay.consume({ ...audience, actorId: 'other-actor' }), undefined);
  assert.deepEqual(relay.consume(audience), {
    sessionId: 'session-1',
    verificationUri: 'https://github.com/login/device',
    userCode: 'WXYZ-1234',
    expiresAt: '2030-01-01T00:00:00.000Z',
  });
  assert.equal(relay.consume(audience), undefined);
});
