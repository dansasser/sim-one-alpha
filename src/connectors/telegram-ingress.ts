import type { Hono } from 'hono';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { goromboPersistenceRuntime } from '../db.js';
import { createChatPrompt } from '../routes/chat-prompt.js';
import { resolveChatSession } from '../session/session-routing.js';
import {
  markTelegramPollerError,
  markTelegramPollerStart,
  markTelegramPollerStop,
  markTelegramUpdateReceived,
} from './telegram-state.js';
import { TelegramApiClient, type TelegramMessage, type TelegramUpdate, generatePairingCode, isMentioned } from './telegram-api.js';
import { normalizeTelegramUpdate } from './telegram.js';

export interface TelegramIngressConfig {
  token: string;
  approvedUserIds: string[];
  botUsername?: string;
  enabled: boolean;
  dmPolicy: 'pairing' | 'allowlist' | 'disabled';
  mentionPatterns?: string[];
}

export interface TelegramIngress {
  start(): void;
  stop(): Promise<void>;
}

export function createTelegramIngress(
  app: Hono,
  env: Record<string, unknown> | undefined,
): TelegramIngress | undefined {
  const config = resolveTelegramIngressConfig(env);
  if (!config.enabled || !config.token) {
    return undefined;
  }

  const api = new TelegramApiClient(config.token);
  let running = false;
  let shuttingDown = false;
  let nextOffset = 0;
  let pollerAbortController: AbortController | undefined;
  let inFlightDelivery: Promise<unknown> | undefined;

  const start = () => {
    if (running) {
      return;
    }
    running = true;
    markTelegramPollerStart();
    void pollLoop();
  };

  const stop = async () => {
    if (!running || shuttingDown) {
      return;
    }
    shuttingDown = true;
    pollerAbortController?.abort();
    if (inFlightDelivery) {
      try {
        await inFlightDelivery;
      } catch {
        // delivery already failed; shutdown continues
      }
    }
    running = false;
    markTelegramPollerStop();
  };

  async function pollLoop(): Promise<void> {
    try {
      const me = await api.getMe();
      const botUsername = config.botUsername ?? me.username ?? '';
      log('poller:start', { username: botUsername });

      while (!shuttingDown) {
        pollerAbortController = new AbortController();
        try {
          const updates = await api.getUpdates(nextOffset, 100, 30, pollerAbortController.signal);
          for (const update of updates) {
            nextOffset = Math.max(nextOffset, update.update_id + 1);
            markTelegramUpdateReceived();
            inFlightDelivery = handleUpdate(update, botUsername);
            try {
              await inFlightDelivery;
            } catch (err) {
              markTelegramPollerError(err);
              log('update:delivery_failed', { error: String(err) });
            } finally {
              inFlightDelivery = undefined;
            }
          }
        } catch (err) {
          if (isAbortError(err)) {
            log('poller:stop', { reason: 'shutdown' });
            break;
          }
          markTelegramPollerError(err);
          log('poller:error', { error: String(err) });
          if (!shuttingDown) {
            await sleep(5000);
          }
        } finally {
          pollerAbortController = undefined;
        }
      }
    } catch (err) {
      markTelegramPollerError(err);
      log('poller:start_failed', { error: String(err) });
      running = false;
      markTelegramPollerStop();
    }
  }

  async function handleUpdate(update: TelegramUpdate, botUsername: string): Promise<void> {
    const message = update.message;
    if (!message) {
      return;
    }

    const senderId = String(message.from?.id ?? '');
    const chatId = String(message.chat.id);
    const chatType = message.chat.type ?? 'private';

    if (!senderId) {
      return;
    }

    const dmPolicy = resolveEffectiveDmPolicy(config.dmPolicy);

    if (dmPolicy === 'disabled') {
      log('gate:drop', { reason: 'disabled', senderId, chatId });
      return;
    }

    const isAllowed = goromboPersistenceRuntime.sessionDatabase.isTelegramUserAllowed(senderId)
      || config.approvedUserIds.includes(senderId);

    if (chatType === 'private') {
      if (!isAllowed) {
        if (dmPolicy === 'allowlist') {
          log('gate:drop', { reason: 'allowlist', senderId, chatId });
          return;
        }
        await handlePairing(message);
        return;
      }
    } else if (chatType === 'group' || chatType === 'supergroup') {
      const group = goromboPersistenceRuntime.sessionDatabase.getTelegramGroup(chatId);
      if (!group) {
        log('gate:drop', { reason: 'group_not_configured', senderId, chatId });
        return;
      }
      if (group.requireMention && !isMentioned(message, botUsername, config.mentionPatterns)) {
        log('gate:drop', { reason: 'no_mention', senderId, chatId });
        return;
      }
      if (group.allowFrom.length > 0 && !group.allowFrom.includes(senderId)) {
        log('gate:drop', { reason: 'group_allowlist', senderId, chatId });
        return;
      }
      if (!isAllowed) {
        log('gate:drop', { reason: 'user_not_allowed', senderId, chatId });
        return;
      }
    } else {
      return;
    }

    log('update:deliver', { senderId, chatId, chatType });

    if (message.text?.trim() === '/help') {
      await api.sendMessage(
        chatId,
        'Send any message to talk with the agent. In groups, mention me or reply to my messages. Admins manage access via the HTTP admin API.',
      );
      return;
    }

    const attachmentPaths = await downloadAttachments(message);
    const event = normalizeTelegramUpdate(withAttachmentPaths(update, attachmentPaths) as unknown as import('./telegram.js').TelegramUpdateLike);
    const sessionResolution = resolveChatSession({ event });

    goromboPersistenceRuntime.sessionDatabase.recordNormalizedMessageEvent({
      event,
      sessionId: sessionResolution.sessionId,
      deliveryKind: 'direct-agent',
    });

    const headers = new Headers();
    headers.set('content-type', 'application/json');
    const apiSecret = readApiSecretFromEnv();
    if (apiSecret) {
      headers.set('x-api-secret', apiSecret);
    }

    try {
      const agentResponse = await app.request(
        `/agents/orchestrator/${encodeURIComponent(sessionResolution.sessionId)}?wait=result`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ message: createChatPrompt(event) }),
        },
      );

      const body = (await readJsonResponse(agentResponse.clone())) as Record<string, unknown> | undefined;
      const text = extractResponseText(body);

      if (text) {
        await api.sendMessage(chatId, text, { replyTo: message.message_id });
        log('reply:sent', { chatId, messageId: message.message_id });
      }
    } catch (err) {
      markTelegramPollerError(err);
      log('reply:failed', { chatId, error: String(err) });
      await api.sendMessage(chatId, 'Sorry, I could not process that message right now.');
    }
  }

  async function handlePairing(message: TelegramMessage): Promise<void> {
    const senderId = String(message.from?.id ?? '');
    const chatId = String(message.chat.id);

    goromboPersistenceRuntime.sessionDatabase.pruneExpiredTelegramPendingPairings();

    const existing = goromboPersistenceRuntime.sessionDatabase.listTelegramPendingPairings().find(
      (p) => p.senderId === senderId,
    );

    if (existing) {
      if (existing.replies >= 2) {
        return;
      }
      await api.sendMessage(
        chatId,
        `Still pending — ask an admin to run: openclaw pairing approve telegram ${existing.code}`,
      );
      return;
    }

    const code = generatePairingCode();
    const now = Date.now();
    const expiresAt = new Date(now + 60 * 60 * 1000).toISOString();

    goromboPersistenceRuntime.sessionDatabase.createTelegramPendingPairing({
      code,
      senderId,
      chatId,
      expiresAt,
    });

    log('gate:pair', { senderId, chatId, code });

    await api.sendMessage(
      chatId,
      `Pairing required — ask an admin to run: openclaw pairing approve telegram ${code}`,
    );
  }

  function resolveInboxDir(): string {
    const configured = process.env.TELEGRAM_INBOX_DIR;
    if (typeof configured === 'string' && configured.trim().length > 0) {
      return resolve(configured.trim());
    }
    return resolve('.gorombo/telegram-inbox');
  }

  async function downloadAttachments(message: TelegramMessage): Promise<string[]> {
    const inboxDir = resolveInboxDir();
    mkdirSync(inboxDir, { recursive: true });

    const fileIds: string[] = [];

    if (message.photo && message.photo.length > 0) {
      fileIds.push(message.photo[message.photo.length - 1].file_id);
    }

    if (message.document?.file_id) {
      fileIds.push(message.document.file_id);
    }

    if (message.voice?.file_id) {
      fileIds.push(message.voice.file_id);
    }

    if (message.audio?.file_id) {
      fileIds.push(message.audio.file_id);
    }

    if (message.video?.file_id) {
      fileIds.push(message.video.file_id);
    }

    if (message.video_note?.file_id) {
      fileIds.push(message.video_note.file_id);
    }

    if (message.sticker?.file_id) {
      fileIds.push(message.sticker.file_id);
    }

    const paths: string[] = [];
    for (const fileId of fileIds) {
      try {
        const file = await api.getFile(fileId);
        const path = await api.downloadFile(file, inboxDir);
        if (path) {
          paths.push(path);
        }
      } catch (err) {
        log('attachment:download_failed', { fileId, error: String(err) });
      }
    }

    return paths;
  }

  function withAttachmentPaths(update: TelegramUpdate, paths: string[]): TelegramUpdate {
    if (!update.message) {
      return update;
    }

    return {
      ...update,
      message: {
        ...update.message,
        __goromboAttachmentPaths: paths,
      } as unknown as TelegramMessage,
    };
  }

  return { start, stop };
}

export function runtimeEnvForIngress(): Record<string, unknown> {
  return { ...process.env };
}

export function resolveTelegramIngressConfig(
  env: Record<string, unknown> | undefined,
): TelegramIngressConfig {
  const mergedEnv = {
    ...process.env,
    ...(env ?? {}),
  };

  const token = readString(mergedEnv.TELEGRAM_BOT_TOKEN);
  const approvedUserIds = parseStringList(mergedEnv.TELEGRAM_APPROVED_USER_IDS);
  const mentionPatterns = parseStringList(mergedEnv.TELEGRAM_MENTION_PATTERNS);

  return {
    token,
    approvedUserIds,
    enabled: Boolean(token),
    dmPolicy: parseDmPolicy(mergedEnv.TELEGRAM_DM_POLICY),
    botUsername: readString(mergedEnv.TELEGRAM_BOT_USERNAME),
    mentionPatterns,
  };
}

function resolveEffectiveDmPolicy(defaultPolicy: TelegramIngressConfig['dmPolicy']): TelegramIngressConfig['dmPolicy'] {
  const stored = goromboPersistenceRuntime.sessionDatabase.getTelegramSetting('dmPolicy');
  if (stored === 'disabled' || stored === 'allowlist' || stored === 'pairing') {
    return stored;
  }
  return defaultPolicy;
}

function readString(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
}

function parseStringList(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) {
    return [];
  }
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseDmPolicy(value: unknown): TelegramIngressConfig['dmPolicy'] {
  const raw = readString(value);
  if (raw === 'pairing' || raw === 'allowlist' || raw === 'disabled') {
    return raw;
  }
  return 'pairing';
}

function readApiSecretFromEnv(): string {
  return typeof process.env.API_SECRET === 'string' ? process.env.API_SECRET : '';
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function extractResponseText(body: Record<string, unknown> | undefined): string | undefined {
  if (!body) {
    return undefined;
  }
  const result = body.result as Record<string, unknown> | undefined;
  if (result && typeof result.text === 'string') {
    return result.text;
  }
  if (typeof body.text === 'string') {
    return body.text;
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function log(event: string, payload: Record<string, unknown>): void {
  process.stderr.write(`telegram:${event} ${JSON.stringify(payload)}\n`);
}
