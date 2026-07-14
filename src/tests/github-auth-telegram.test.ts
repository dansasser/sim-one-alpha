import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryGithubAuthChallengeRelay } from '../api/ingress/github-auth-challenge-relay.js';
import { deliverTelegramGithubAuthChallenge } from '../channels/telegram.js';

const event = {
  id: 'telegram:auth-delivery',
  connector: 'telegram',
  kind: 'chat.message',
  text: 'authenticate GitHub',
  receivedAt: new Date().toISOString(),
  actor: { id: 'actor-1' },
  conversation: { id: '-100123', threadId: '42' },
} as const;
const audience = {
  connector: event.connector,
  actorId: event.actor.id,
  conversationId: event.conversation.id,
  eventId: event.id,
};

test('Telegram connector privately consumes and sends its audience-bound GitHub challenge', async () => {
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
    resolveEvent: (eventId) => eventId === event.id ? event : undefined,
    sendMessage: async (chatId, text, options) => {
      sends.push({ chatId, text, threadId: options.messageThreadId });
    },
  }), true);
  assert.deepEqual(sends, [{
    chatId: event.conversation.id,
    text: 'Open https://github.com/login/device and enter code TGRA-0001 to authorize GitHub.',
    threadId: 42,
  }]);
  assert.equal(relay.consume(audience), undefined);
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
    resolveEvent: () => ({ ...event, actor: { id: 'other-actor' } }),
    sendMessage: async () => { throw new Error('must not send'); },
  }), false);
  assert.notEqual(relay.consume(audience), undefined, 'mismatched delivery must not consume the challenge');
});
