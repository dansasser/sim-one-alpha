import type { Hono } from 'hono';
import { TelegramApiClient } from '../../api/connectors/telegram/telegram-api.js';
import { telegramConnectorState } from '../../api/connectors/telegram/telegram-state.js';
import { requireApiSecret } from '../../api/middleware/api-secret.js';
import { goromboPersistenceRuntime } from '../../core/db.js';

const DM_POLICIES = ['disabled', 'allowlist', 'pairing'] as const;
type DmPolicy = (typeof DM_POLICIES)[number];

export function registerTelegramAdminRoutes(app: Hono): void {
  const notifier = createAdminNotifier();

  app.get('/api/connectors/telegram/status', requireApiSecret, (c) => {
    return c.json({
      connector: 'telegram',
      dmPolicy: readDmPolicy() ?? 'pairing',
      allowedUsers: goromboPersistenceRuntime.sessionDatabase.listTelegramAllowedUsers(),
      pendingPairings: goromboPersistenceRuntime.sessionDatabase.listTelegramPendingPairings(),
      groups: goromboPersistenceRuntime.sessionDatabase.listTelegramGroups(),
    });
  });

  app.get('/api/connectors/telegram/health', requireApiSecret, (c) => {
    return c.json({
      connector: 'telegram',
      enabled: telegramConnectorState.enabled,
      pollerRunning: telegramConnectorState.pollerRunning,
      pollerStartedAt: telegramConnectorState.pollerStartedAt,
      lastUpdateReceivedAt: telegramConnectorState.lastUpdateReceivedAt,
      updateCount: telegramConnectorState.updateCount,
      errorCount: telegramConnectorState.errorCount,
      lastError: telegramConnectorState.lastError,
      pendingPairingCount: goromboPersistenceRuntime.sessionDatabase.listTelegramPendingPairings().length,
      allowedUserCount: goromboPersistenceRuntime.sessionDatabase.listTelegramAllowedUsers().length,
      dmPolicy: readDmPolicy() ?? 'pairing',
    });
  });

  app.post('/api/connectors/telegram/pair', requireApiSecret, async (c) => {
    const body = await parseJsonBody(c);
    const code = readString(body?.code);

    if (!code) {
      return c.json({ error: 'Missing code.' }, 400);
    }

    goromboPersistenceRuntime.sessionDatabase.pruneExpiredTelegramPendingPairings();
    const approved = goromboPersistenceRuntime.sessionDatabase.approveTelegramPendingPairing(code);

    if (!approved) {
      return c.json({ error: 'Pairing code not found or expired.' }, 404);
    }

    await notifier.notify(
      approved.chatId,
      'You have been approved. Send me a message to begin. Reply /help for available commands.',
    );

    return c.json({ approved: true, userId: approved.userId, chatId: approved.chatId });
  });

  app.post('/api/connectors/telegram/deny', requireApiSecret, async (c) => {
    const body = await parseJsonBody(c);
    const code = readString(body?.code);

    if (!code) {
      return c.json({ error: 'Missing code.' }, 400);
    }

    const pending = goromboPersistenceRuntime.sessionDatabase.getTelegramPendingPairing(code);
    const deleted = goromboPersistenceRuntime.sessionDatabase.deleteTelegramPendingPairing(code);

    if (pending && deleted) {
      await notifier.notify(
        pending.chatId,
        'Your pairing request was not approved. Contact an administrator if you believe this is a mistake.',
      );
    }

    return c.json({ denied: deleted });
  });

  app.post('/api/connectors/telegram/allow', requireApiSecret, async (c) => {
    const body = await parseJsonBody(c);
    const userId = readString(body?.userId);
    const chatId = readString(body?.chatId) ?? userId;

    if (!userId) {
      return c.json({ error: 'Missing userId.' }, 400);
    }

    const resolvedChatId = chatId ?? userId;
    if (!isTelegramChatId(resolvedChatId)) {
      return c.json({ error: 'Invalid chatId. Must be a numeric ID or @username.' }, 400);
    }

    goromboPersistenceRuntime.sessionDatabase.addTelegramAllowedUser({ userId, chatId: resolvedChatId });
    await notifier.notify(
      resolvedChatId,
      'You have been added to the approved users list. Send me a message to begin.',
    );

    return c.json({ allowed: true, userId, chatId: resolvedChatId });
  });

  app.post('/api/connectors/telegram/remove', requireApiSecret, async (c) => {
    const body = await parseJsonBody(c);
    const userId = readString(body?.userId);
    const notify = body?.notify === true;

    if (!userId) {
      return c.json({ error: 'Missing userId.' }, 400);
    }

    const allowed = goromboPersistenceRuntime.sessionDatabase
      .listTelegramAllowedUsers()
      .find((u) => u.userId === userId);

    goromboPersistenceRuntime.sessionDatabase.removeTelegramAllowedUser(userId);

    if (notify && allowed) {
      await notifier.notify(
        allowed.chatId,
        'You have been removed from the approved users list.',
      );
    }

    return c.json({ removed: true, userId });
  });

  app.post('/api/connectors/telegram/policy', requireApiSecret, async (c) => {
    const body = await parseJsonBody(c);
    const dmPolicy = readString(body?.dmPolicy);

    if (!dmPolicy || !isDmPolicy(dmPolicy)) {
      return c.json({ error: `dmPolicy must be one of ${DM_POLICIES.join(', ')}.` }, 400);
    }

    goromboPersistenceRuntime.sessionDatabase.setTelegramSetting('dmPolicy', dmPolicy);
    return c.json({ policy: true, dmPolicy });
  });

  app.get('/api/connectors/telegram/groups', requireApiSecret, (c) => {
    return c.json({ groups: goromboPersistenceRuntime.sessionDatabase.listTelegramGroups() });
  });

  app.post('/api/connectors/telegram/group', requireApiSecret, async (c) => {
    const body = await parseJsonBody(c);
    const groupId = readString(body?.groupId);

    if (!groupId) {
      return c.json({ error: 'Missing groupId.' }, 400);
    }

    const requireMention = typeof body?.requireMention === 'boolean' ? body.requireMention : true;
    const allowFrom = Array.isArray(body?.allowFrom)
      ? body.allowFrom.filter((item): item is string => typeof item === 'string')
      : undefined;

    goromboPersistenceRuntime.sessionDatabase.setTelegramGroup({
      groupId,
      requireMention,
      allowFrom,
    });

    return c.json({ configured: true, groupId, requireMention, allowFrom });
  });

  app.delete('/api/connectors/telegram/group/:groupId', requireApiSecret, (c) => {
    const groupId = c.req.param('groupId');
    const removed = goromboPersistenceRuntime.sessionDatabase.removeTelegramGroup(groupId);

    if (!removed) {
      return c.json({ error: 'Group not found.' }, 404);
    }

    return c.json({ removed: true, groupId });
  });
}

function createAdminNotifier() {
  const token = readTelegramBotToken();
  if (!token) {
    return { notify: async () => undefined };
  }

  const api = new TelegramApiClient(token);
  return {
    notify: async (chatId: string, text: string) => {
      try {
        await api.sendMessage(chatId, text);
      } catch (error) {
        process.stderr.write(`telegram admin notifier: ${error}\n`);
      }
    },
  };
}

function readTelegramBotToken(): string {
  return typeof process.env.TELEGRAM_BOT_TOKEN === 'string' && process.env.TELEGRAM_BOT_TOKEN.trim().length > 0
    ? process.env.TELEGRAM_BOT_TOKEN.trim()
    : '';
}

function readDmPolicy(): DmPolicy | null {
  const stored = goromboPersistenceRuntime.sessionDatabase.getTelegramSetting('dmPolicy');
  return stored && isDmPolicy(stored) ? stored : null;
}

function isDmPolicy(value: string): value is DmPolicy {
  return DM_POLICIES.includes(value as DmPolicy);
}

function isTelegramChatId(value: string): boolean {
  if (/^\d+$/.test(value)) return true;
  if (/^@[a-zA-Z0-9_]{5,32}$/.test(value)) return true;
  return false;
}

async function parseJsonBody(c: Parameters<typeof requireApiSecret>[0]): Promise<Record<string, unknown> | undefined> {
  try {
    return (await c.req.json()) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
