import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryGithubAuthChallengeRelay } from '../api/ingress/github-auth-challenge-relay.js';
import { deliverTelegramGithubAuthChallenge } from '../channels/telegram.js';

const groupEvent = {
  id: 'telegram:auth-delivery',
  connector: 'telegram',
  kind: 'chat.message',
  text: 'authenticate GitHub',
  receivedAt: new Date().toISOString(),
  actor: { id: 'actor-1' },
  conversation: { id: '-100123', threadId: '42' },
} as const;
const privateEvent = {
  ...groupEvent,
  id: 'telegram:auth-private-delivery',
  conversation: { id: groupEvent.actor.id },
} as const;
const audience = {
  connector: privateEvent.connector,
  actorId: privateEvent.actor.id,
  conversationId: privateEvent.conversation.id,
  eventId: privateEvent.id,
};

test('Telegram connector sends a private-chat challenge only to its initiating actor', async () => {
  const relay = new InMemoryGithubAuthChallengeRelay();
  const sends: Array<{ chatId: string; text: string; threadId?: number }> = [];
  relay.deliver({
    sessionId: 'session-telegram',
    audience,
    verificationUri: 'https://github.com/login/device',
    userCode: 'TGRA-0001',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });

  assert.equal(await deliverTelegramGithubAuthChallenge(audience, {
    relay,
    resolveEvent: (eventId) => eventId === privateEvent.id ? privateEvent : undefined,
    sendMessage: async (chatId, text, options) => {
      sends.push({ chatId, text, threadId: options.messageThreadId });
    },
  }), true);
  assert.deepEqual(sends, [{
    chatId: privateEvent.actor.id,
    text: 'Open https://github.com/login/device and enter code TGRA-0001 to authorize GitHub.',
    threadId: undefined,
  }]);
  assert.equal(relay.consume(audience), undefined);
});

test('Telegram connector leaves a challenge pending when private delivery fails', async () => {
  const relay = new InMemoryGithubAuthChallengeRelay();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const retryEvent = { ...privateEvent, id: 'telegram:auth-private-retry' };
  const retryAudience = { ...audience, eventId: retryEvent.id };
  const sends: string[] = [];
  relay.deliver({
    sessionId: 'session-telegram-retry',
    audience,
    verificationUri: 'https://github.com/login/device',
    userCode: 'TGRA-RETRY',
    expiresAt,
  });

  await assert.rejects(
    deliverTelegramGithubAuthChallenge(audience, {
      relay,
      resolveEvent: (eventId) => eventId === privateEvent.id ? privateEvent : undefined,
      sendMessage: async () => { throw new Error('temporary Telegram failure'); },
    }),
    /temporary Telegram failure/,
  );
  assert.equal(await deliverTelegramGithubAuthChallenge(retryAudience, {
    relay,
    resolveEvent: (eventId) => eventId === retryEvent.id ? retryEvent : undefined,
    sendMessage: async (_chatId, text) => { sends.push(text); },
  }), true);
  assert.deepEqual(sends, [
    'Open https://github.com/login/device and enter code TGRA-RETRY to authorize GitHub.',
  ]);
  assert.equal(relay.consume(retryAudience), undefined);
});

test('Telegram connector refuses to expose a group challenge and leaves it pending', async () => {
  const relay = new InMemoryGithubAuthChallengeRelay();
  const groupAudience = {
    connector: groupEvent.connector,
    actorId: groupEvent.actor.id,
    conversationId: groupEvent.conversation.id,
    eventId: groupEvent.id,
  };
  relay.deliver({
    sessionId: 'session-telegram-group',
    audience: groupAudience,
    verificationUri: 'https://github.com/login/device',
    userCode: 'TGRA-GROUP',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });

  assert.equal(await deliverTelegramGithubAuthChallenge(groupAudience, {
    relay,
    resolveEvent: (eventId) => eventId === groupEvent.id ? groupEvent : undefined,
    sendMessage: async () => { throw new Error('must not expose a group challenge'); },
  }), false);
  assert.notEqual(relay.consume(groupAudience), undefined);
});

test('Telegram connector refuses a challenge whose persisted event audience does not match', async () => {
  const relay = new InMemoryGithubAuthChallengeRelay();
  relay.deliver({
    sessionId: 'session-telegram-mismatch',
    audience,
    verificationUri: 'https://github.com/login/device',
    userCode: 'TGRA-0002',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });

  assert.equal(await deliverTelegramGithubAuthChallenge(audience, {
    relay,
    resolveEvent: () => ({ ...privateEvent, actor: { id: 'other-actor' } }),
    sendMessage: async () => { throw new Error('must not send'); },
  }), false);
  assert.notEqual(relay.consume(audience), undefined, 'mismatched delivery must not consume the challenge');
});
