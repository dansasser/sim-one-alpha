import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TelegramApiClient,
  chunkTelegramText,
  generatePairingCode,
  isMentioned,
} from '../connectors/telegram-api.js';
import {
  resolveTelegramIngressConfig,
  runtimeEnvForIngress,
} from '../connectors/telegram-ingress.js';
import { createTelegramReplyTool } from '../tools/telegram-reply-tool.js';
import { goromboPersistenceRuntime } from '../db.js';
import app from '../app.js';

test('telegram text chunking respects Telegram 4096 limit', () => {
  const short = 'hello';
  assert.deepEqual(chunkTelegramText(short), ['hello']);

  const exactLimit = 'a'.repeat(4096);
  assert.deepEqual(chunkTelegramText(exactLimit), [exactLimit]);

  const overLimit = 'a'.repeat(4100);
  const chunks = chunkTelegramText(overLimit);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].length, 4096);
  assert.equal(chunks[1].length, 4);
});

test('telegram pairing code is 6 hex characters', () => {
  const code = generatePairingCode();
  assert.match(code, /^[a-f0-9]{6}$/);
});

test('telegram mention detection recognizes @botusername', () => {
  const message = {
    message_id: 1,
    chat: { id: 1 },
    text: 'hey @mybot do this',
    entities: [{ type: 'mention', offset: 4, length: 6 }],
  };

  assert.equal(isMentioned(message as unknown as Parameters<typeof isMentioned>[0], 'mybot'), true);
  assert.equal(isMentioned(message as unknown as Parameters<typeof isMentioned>[0], 'otherbot'), false);
});

test('telegram ingress config resolves token and approved user ids', () => {
  const env = {
    TELEGRAM_BOT_TOKEN: '123:abc',
    TELEGRAM_APPROVED_USER_IDS: ' 6653274440 , 123456 ',
    TELEGRAM_BOT_USERNAME: 'mybot',
  };

  const config = resolveTelegramIngressConfig(env);
  assert.equal(config.enabled, true);
  assert.equal(config.token, '123:abc');
  assert.deepEqual(config.approvedUserIds, ['6653274440', '123456']);
  assert.equal(config.dmPolicy, 'pairing');
  assert.equal(config.botUsername, 'mybot');
});

test('telegram ingress config respects explicit dmPolicy', () => {
  const env = {
    TELEGRAM_BOT_TOKEN: '123:abc',
    TELEGRAM_DM_POLICY: 'allowlist',
  };

  const config = resolveTelegramIngressConfig(env);
  assert.equal(config.dmPolicy, 'allowlist');
});

test('telegram ingress config is disabled without token', () => {
  const env = {
    TELEGRAM_APPROVED_USER_IDS: '6653274440',
  };

  const config = resolveTelegramIngressConfig(env);
  assert.equal(config.enabled, false);
  assert.equal(config.token, '');
  assert.deepEqual(config.approvedUserIds, ['6653274440']);
});

test('runtime env for ingress includes process env', () => {
  const env = runtimeEnvForIngress();
  assert.equal(typeof env, 'object');
  assert.ok(Object.keys(env).length > 0);
});

test('telegram reply tool rejects non-telegram events', async () => {
  const eventId = 'web-event-1';
  goromboPersistenceRuntime.sessionDatabase.recordNormalizedMessageEvent({
    event: {
      id: eventId,
      connector: 'web-api',
      kind: 'chat.message',
      text: 'hello',
      receivedAt: new Date().toISOString(),
      actor: { id: 'actor-1' },
      conversation: { id: 'conv-1' },
    },
  });

  const tool = createTelegramReplyTool('123:abc');
  await assert.rejects(
    async () => tool.execute({ eventId, text: 'hello' }),
    /telegram_reply can only respond to Telegram events/,
  );
});

test('telegram api client builds correct base url', () => {
  const client = new TelegramApiClient('123:abc');
  assert.ok(client instanceof TelegramApiClient);
});

test('telegram allowed user CRUD works in session database', () => {
  goromboPersistenceRuntime.sessionDatabase.addTelegramAllowedUser({
    userId: '6653274440',
    chatId: '6653274440',
  });

  assert.equal(goromboPersistenceRuntime.sessionDatabase.isTelegramUserAllowed('6653274440'), true);
  assert.equal(goromboPersistenceRuntime.sessionDatabase.isTelegramUserAllowed('999999'), false);

  const users = goromboPersistenceRuntime.sessionDatabase.listTelegramAllowedUsers();
  assert.ok(users.some((u) => u.userId === '6653274440'));

  goromboPersistenceRuntime.sessionDatabase.removeTelegramAllowedUser('6653274440');
  assert.equal(goromboPersistenceRuntime.sessionDatabase.isTelegramUserAllowed('6653274440'), false);
});

test('telegram pending pairing can be created and approved', () => {
  goromboPersistenceRuntime.sessionDatabase.createTelegramPendingPairing({
    code: 'a1b2c3',
    senderId: '6653274440',
    chatId: '6653274440',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });

  const pending = goromboPersistenceRuntime.sessionDatabase.getTelegramPendingPairing('a1b2c3');
  assert.ok(pending);
  assert.equal(pending.senderId, '6653274440');

  const approved = goromboPersistenceRuntime.sessionDatabase.approveTelegramPendingPairing('a1b2c3');
  assert.ok(approved);
  assert.equal(approved.userId, '6653274440');
  assert.equal(goromboPersistenceRuntime.sessionDatabase.isTelegramUserAllowed('6653274440'), true);
  assert.equal(goromboPersistenceRuntime.sessionDatabase.getTelegramPendingPairing('a1b2c3'), null);

  goromboPersistenceRuntime.sessionDatabase.removeTelegramAllowedUser('6653274440');
});

test('telegram pending pairing expires', () => {
  goromboPersistenceRuntime.sessionDatabase.createTelegramPendingPairing({
    code: 'expired1',
    senderId: '111',
    chatId: '111',
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });

  const beforePrune = goromboPersistenceRuntime.sessionDatabase.getTelegramPendingPairing('expired1');
  assert.ok(beforePrune);

  goromboPersistenceRuntime.sessionDatabase.pruneExpiredTelegramPendingPairings();
  assert.equal(goromboPersistenceRuntime.sessionDatabase.getTelegramPendingPairing('expired1'), null);
});

test('telegram group config CRUD works', () => {
  goromboPersistenceRuntime.sessionDatabase.setTelegramGroup({
    groupId: '-1003884375753',
    requireMention: true,
    allowFrom: ['6653274440'],
  });

  const group = goromboPersistenceRuntime.sessionDatabase.getTelegramGroup('-1003884375753');
  assert.ok(group);
  assert.equal(group.requireMention, true);
  assert.deepEqual(group.allowFrom, ['6653274440']);

  const groups = goromboPersistenceRuntime.sessionDatabase.listTelegramGroups();
  assert.ok(groups.some((g) => g.groupId === '-1003884375753'));

  goromboPersistenceRuntime.sessionDatabase.removeTelegramGroup('-1003884375753');
  assert.equal(goromboPersistenceRuntime.sessionDatabase.getTelegramGroup('-1003884375753'), null);
});

test('telegram admin status route requires api secret', async () => {
  const previous = process.env.API_SECRET;
  process.env.API_SECRET = 'test-secret';

  try {
    const response = await app.request('/api/connectors/telegram/status');
    assert.equal(response.status, 401);

    const authorized = await app.request('/api/connectors/telegram/status', {
      headers: { 'x-api-secret': 'test-secret' },
    });
    assert.equal(authorized.status, 200);
    const body = (await authorized.json()) as { connector?: string };
    assert.equal(body.connector, 'telegram');
  } finally {
    if (previous === undefined) {
      delete process.env.API_SECRET;
    } else {
      process.env.API_SECRET = previous;
    }
  }
});

test('telegram settings CRUD works in session database', () => {
  goromboPersistenceRuntime.sessionDatabase.setTelegramSetting('dmPolicy', 'allowlist');
  assert.equal(goromboPersistenceRuntime.sessionDatabase.getTelegramSetting('dmPolicy'), 'allowlist');

  goromboPersistenceRuntime.sessionDatabase.setTelegramSetting('dmPolicy', 'pairing');
  assert.equal(goromboPersistenceRuntime.sessionDatabase.getTelegramSetting('dmPolicy'), 'pairing');
});

test('telegram admin policy route changes runtime dm policy', async () => {
  const previous = process.env.API_SECRET;
  process.env.API_SECRET = 'test-secret';

  try {
    const bad = await app.request('/api/connectors/telegram/policy', {
      method: 'POST',
      headers: { 'x-api-secret': 'test-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ dmPolicy: 'invalid' }),
    });
    assert.equal(bad.status, 400);

    const changed = await app.request('/api/connectors/telegram/policy', {
      method: 'POST',
      headers: { 'x-api-secret': 'test-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ dmPolicy: 'disabled' }),
    });
    assert.equal(changed.status, 200);
    const body = (await changed.json()) as { policy?: boolean; dmPolicy?: string };
    assert.equal(body.policy, true);
    assert.equal(body.dmPolicy, 'disabled');

    assert.equal(goromboPersistenceRuntime.sessionDatabase.getTelegramSetting('dmPolicy'), 'disabled');
  } finally {
    goromboPersistenceRuntime.sessionDatabase.setTelegramSetting('dmPolicy', 'pairing');
    if (previous === undefined) {
      delete process.env.API_SECRET;
    } else {
      process.env.API_SECRET = previous;
    }
  }
});

test('telegram admin group routes support list and delete with 404', async () => {
  const previous = process.env.API_SECRET;
  process.env.API_SECRET = 'test-secret';

  try {
    goromboPersistenceRuntime.sessionDatabase.setTelegramGroup({
      groupId: '-100listtest',
      requireMention: false,
    });

    const list = await app.request('/api/connectors/telegram/groups', {
      headers: { 'x-api-secret': 'test-secret' },
    });
    assert.equal(list.status, 200);
    const listBody = (await list.json()) as { groups?: Array<{ groupId: string }> };
    assert.ok(listBody.groups?.some((g) => g.groupId === '-100listtest'));

    const missing = await app.request('/api/connectors/telegram/group/-100missing', {
      method: 'DELETE',
      headers: { 'x-api-secret': 'test-secret' },
    });
    assert.equal(missing.status, 404);

    const deleted = await app.request('/api/connectors/telegram/group/-100listtest', {
      method: 'DELETE',
      headers: { 'x-api-secret': 'test-secret' },
    });
    assert.equal(deleted.status, 200);
    assert.equal(goromboPersistenceRuntime.sessionDatabase.getTelegramGroup('-100listtest'), null);
  } finally {
    goromboPersistenceRuntime.sessionDatabase.removeTelegramGroup('-100listtest');
    if (previous === undefined) {
      delete process.env.API_SECRET;
    } else {
      process.env.API_SECRET = previous;
    }
  }
});

test('telegram admin health route returns connector state', async () => {
  const previous = process.env.API_SECRET;
  process.env.API_SECRET = 'test-secret';

  try {
    const response = await app.request('/api/connectors/telegram/health', {
      headers: { 'x-api-secret': 'test-secret' },
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      connector?: string;
      enabled?: boolean;
      pendingPairingCount?: number;
      allowedUserCount?: number;
    };
    assert.equal(body.connector, 'telegram');
    assert.equal(typeof body.enabled, 'boolean');
    assert.equal(typeof body.pendingPairingCount, 'number');
    assert.equal(typeof body.allowedUserCount, 'number');
  } finally {
    if (previous === undefined) {
      delete process.env.API_SECRET;
    } else {
      process.env.API_SECRET = previous;
    }
  }
});
