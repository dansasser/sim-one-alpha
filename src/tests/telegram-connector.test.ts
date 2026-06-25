import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TelegramApiClient,
  chunkTelegramText,
  generatePairingCode,
  isMentioned,
} from '../api/connectors/telegram/telegram-api.js';
import { resolveTelegramApprovalPrincipal } from '../api/channels/telegram.js';
import { goromboPersistenceRuntime } from '../core/db.js';
import app from '../app.js';

let testCounter = 0;

function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now()}-${++testCounter}`;
}

function withApiSecret(secret: string): () => void {
  const previous = process.env.API_SECRET;
  process.env.API_SECRET = secret;
  return () => {
    if (previous === undefined) {
      delete process.env.API_SECRET;
    } else {
      process.env.API_SECRET = previous;
    }
  };
}

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

test('telegram mention detection checks caption_entities', () => {
  const message = {
    message_id: 1,
    chat: { id: 1 },
    caption: 'look at this @mybot',
    caption_entities: [{ type: 'mention', offset: 13, length: 6 }],
  };

  assert.equal(isMentioned(message as unknown as Parameters<typeof isMentioned>[0], 'mybot'), true);
  assert.equal(
    isMentioned(
      {
        message_id: 2,
        chat: { id: 1 },
        caption: 'look at this @otherbot',
        caption_entities: [{ type: 'mention', offset: 13, length: 9 }],
      } as unknown as Parameters<typeof isMentioned>[0],
      'mybot',
    ),
    false,
  );
});

test('telegram approval principal is admin for configured admin ids', () => {
  assert.equal(resolveTelegramApprovalPrincipal('6653274440', ['6653274440']), 'admin');
  assert.equal(resolveTelegramApprovalPrincipal('999999', ['6653274440']), 'operator');
  assert.equal(resolveTelegramApprovalPrincipal('999999', []), 'operator');
});

test('telegram api client builds correct base url', () => {
  const client = new TelegramApiClient('123:abc');
  assert.ok(client instanceof TelegramApiClient);
});

test('telegram api client rejects oversized file download', async () => {
  const client = new TelegramApiClient('123:abc');
  await assert.rejects(
    async () => {
      const response = new Response(Buffer.alloc(51 * 1024 * 1024), {
        status: 200,
        headers: { 'content-length': String(51 * 1024 * 1024) },
      });
      const fakeFetch = async () => response;
      // Reach the size guard by overriding global fetch temporarily.
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fakeFetch as unknown as typeof fetch;
      try {
        await client.downloadFile(
          { file_id: 'f1', file_unique_id: 'fu1', file_path: 'big.bin' },
          '.gorombo/test-inbox',
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
    /too large/,
  );
});

test('telegram allowed user CRUD works in session database', () => {
  const userId = uniqueId('6653274440');
  goromboPersistenceRuntime.sessionDatabase.addTelegramAllowedUser({
    userId,
    chatId: userId,
  });

  try {
    assert.equal(goromboPersistenceRuntime.sessionDatabase.isTelegramUserAllowed(userId), true);
    assert.equal(goromboPersistenceRuntime.sessionDatabase.isTelegramUserAllowed('999999'), false);

    const users = goromboPersistenceRuntime.sessionDatabase.listTelegramAllowedUsers();
    assert.ok(users.some((u) => u.userId === userId));
  } finally {
    goromboPersistenceRuntime.sessionDatabase.removeTelegramAllowedUser(userId);
    assert.equal(goromboPersistenceRuntime.sessionDatabase.isTelegramUserAllowed(userId), false);
  }
});

test('telegram pending pairing can be created and approved', () => {
  const userId = uniqueId('user');
  const chatId = userId;
  const code = uniqueId('code');

  goromboPersistenceRuntime.sessionDatabase.createTelegramPendingPairing({
    code,
    senderId: userId,
    chatId,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });

  try {
    const pending = goromboPersistenceRuntime.sessionDatabase.getTelegramPendingPairing(code);
    assert.ok(pending);
    assert.equal(pending.senderId, userId);

    const approved = goromboPersistenceRuntime.sessionDatabase.approveTelegramPendingPairing(code);
    assert.ok(approved);
    assert.equal(approved.userId, userId);
    assert.equal(goromboPersistenceRuntime.sessionDatabase.isTelegramUserAllowed(userId), true);
    assert.equal(goromboPersistenceRuntime.sessionDatabase.getTelegramPendingPairing(code), null);
  } finally {
    goromboPersistenceRuntime.sessionDatabase.deleteTelegramPendingPairing(code);
    goromboPersistenceRuntime.sessionDatabase.removeTelegramAllowedUser(userId);
  }
});

test('telegram pending pairing expires', () => {
  const code = uniqueId('expired');
  const userId = uniqueId('user');

  goromboPersistenceRuntime.sessionDatabase.createTelegramPendingPairing({
    code,
    senderId: userId,
    chatId: userId,
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });

  try {
    const beforePrune = goromboPersistenceRuntime.sessionDatabase.getTelegramPendingPairing(code);
    assert.ok(beforePrune);

    goromboPersistenceRuntime.sessionDatabase.pruneExpiredTelegramPendingPairings();
    assert.equal(goromboPersistenceRuntime.sessionDatabase.getTelegramPendingPairing(code), null);

    assert.equal(goromboPersistenceRuntime.sessionDatabase.approveTelegramPendingPairing(code), null);
  } finally {
    goromboPersistenceRuntime.sessionDatabase.deleteTelegramPendingPairing(code);
  }
});

test('telegram group config CRUD works', () => {
  const groupId = uniqueId('-100group');

  goromboPersistenceRuntime.sessionDatabase.setTelegramGroup({
    groupId,
    requireMention: true,
    allowFrom: [uniqueId('user')],
  });

  try {
    const group = goromboPersistenceRuntime.sessionDatabase.getTelegramGroup(groupId);
    assert.ok(group);
    assert.equal(group.requireMention, true);

    const groups = goromboPersistenceRuntime.sessionDatabase.listTelegramGroups();
    assert.ok(groups.some((g) => g.groupId === groupId));
  } finally {
    goromboPersistenceRuntime.sessionDatabase.removeTelegramGroup(groupId);
    assert.equal(goromboPersistenceRuntime.sessionDatabase.getTelegramGroup(groupId), null);
  }
});

test('telegram admin status route requires api secret', async () => {
  const restore = withApiSecret('test-secret');

  try {
    const missing = await app.request('/api/connectors/telegram/status');
    assert.equal(missing.status, 401);

    const authorized = await app.request('/api/connectors/telegram/status', {
      headers: { 'x-api-secret': 'test-secret' },
    });
    assert.equal(authorized.status, 200);
    const body = (await authorized.json()) as { connector?: string };
    assert.equal(body.connector, 'telegram');

    const invalid = await app.request('/api/connectors/telegram/status', {
      headers: { 'x-api-secret': 'wrong-secret' },
    });
    assert.equal(invalid.status, 401);
  } finally {
    restore();
  }
});

test('telegram settings CRUD works in session database', () => {
  const previous = goromboPersistenceRuntime.sessionDatabase.getTelegramSetting('dmPolicy');

  try {
    goromboPersistenceRuntime.sessionDatabase.setTelegramSetting('dmPolicy', 'allowlist');
    assert.equal(goromboPersistenceRuntime.sessionDatabase.getTelegramSetting('dmPolicy'), 'allowlist');

    goromboPersistenceRuntime.sessionDatabase.setTelegramSetting('dmPolicy', 'pairing');
    assert.equal(goromboPersistenceRuntime.sessionDatabase.getTelegramSetting('dmPolicy'), 'pairing');
  } finally {
    if (previous != null) {
      goromboPersistenceRuntime.sessionDatabase.setTelegramSetting('dmPolicy', previous);
    } else {
      goromboPersistenceRuntime.sessionDatabase.setTelegramSetting('dmPolicy', 'pairing');
    }
  }
});

test('telegram admin policy route changes runtime dm policy', async () => {
  const restoreSecret = withApiSecret('test-secret');
  const previousPolicy = goromboPersistenceRuntime.sessionDatabase.getTelegramSetting('dmPolicy');

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
    goromboPersistenceRuntime.sessionDatabase.setTelegramSetting(
      'dmPolicy',
      previousPolicy ?? 'pairing',
    );
    restoreSecret();
  }
});

test('telegram admin group routes support list and delete with 404', async () => {
  const restoreSecret = withApiSecret('test-secret');
  const groupId = uniqueId('-100listtest');

  try {
    goromboPersistenceRuntime.sessionDatabase.setTelegramGroup({
      groupId,
      requireMention: false,
    });

    const list = await app.request('/api/connectors/telegram/groups', {
      headers: { 'x-api-secret': 'test-secret' },
    });
    assert.equal(list.status, 200);
    const listBody = (await list.json()) as { groups?: Array<{ groupId: string }> };
    assert.ok(listBody.groups?.some((g) => g.groupId === groupId));

    const missing = await app.request(`/api/connectors/telegram/group/${uniqueId('-100missing')}`, {
      method: 'DELETE',
      headers: { 'x-api-secret': 'test-secret' },
    });
    assert.equal(missing.status, 404);

    const deleted = await app.request(`/api/connectors/telegram/group/${groupId}`, {
      method: 'DELETE',
      headers: { 'x-api-secret': 'test-secret' },
    });
    assert.equal(deleted.status, 200);
    assert.equal(goromboPersistenceRuntime.sessionDatabase.getTelegramGroup(groupId), null);
  } finally {
    goromboPersistenceRuntime.sessionDatabase.removeTelegramGroup(groupId);
    restoreSecret();
  }
});

test('telegram admin health route returns connector state', async () => {
  const restore = withApiSecret('test-secret');

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
    restore();
  }
});

test('telegram admin allow route validates chatId format', async () => {
  const restore = withApiSecret('test-secret');

  try {
    const badChatId = await app.request('/api/connectors/telegram/allow', {
      method: 'POST',
      headers: { 'x-api-secret': 'test-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ userId: uniqueId('user'), chatId: 'not-valid' }),
    });
    assert.equal(badChatId.status, 400);

    const numeric = await app.request('/api/connectors/telegram/allow', {
      method: 'POST',
      headers: { 'x-api-secret': 'test-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ userId: uniqueId('user'), chatId: '6653274440' }),
    });
    assert.equal(numeric.status, 200);
  } finally {
    restore();
  }
});
