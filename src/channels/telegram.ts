import { dispatch, defineTool } from '@flue/runtime';
import { createTelegramChannel, type TelegramConversationRef } from '@flue/telegram';
import { Api } from 'grammy';
import type { Message, Update } from 'grammy/types';
import orchestratorAgent from '../agents/orchestrator.js';
import {
  createApprovalIngress,
  createFileApprovalBindingStore,
} from '../api/ingress/approval-ingress.js';
import { createSharedCodingApprovalService } from '../engine/approvals/shared-approval-service.js';
import { goromboPersistenceRuntime } from '../db.js';
import { resolveChatSession } from '../engine/session/session-routing.js';
import { createChatPrompt } from '../api/routes/chat-prompt.js';
import { normalizeTelegramUpdate } from '../api/connectors/telegram/telegram.js';
import { buildApprovalResolvedMessage, parseApprovalCallback } from '../api/connectors/telegram/approval-ui/index.js';
import { markTelegramUpdateReceived } from '../api/connectors/telegram/telegram-state.js';
import { isMentioned } from '../api/connectors/telegram/telegram-api.js';
import type { NormalizedMessageEvent } from '../core/types/index.js';
import * as v from 'valibot';

function isTestMode(): boolean {
  return process.env.NODE_ENV === 'test' || process.env.GOROMBO_TEST_MODE === '1';
}

function isTelegramConfigured(): boolean {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  return (typeof token === 'string' && token.trim().length > 0) || isTestMode();
}

function getTelegramBotToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    if (isTestMode()) {
      return 'placeholder-token';
    }
    throw new Error(
      'TELEGRAM_BOT_TOKEN environment variable is required. Set it to enable Telegram, or omit it to run without Telegram (TUI/HTTP only).',
    );
  }
  return token;
}

let cachedClient: Api | undefined;

export const client = new Proxy({} as Api, {
  get(_target, prop, receiver) {
    if (!cachedClient) {
      cachedClient = new Api(getTelegramBotToken());
    }
    return Reflect.get(cachedClient, prop, receiver);
  },
});

type DmPolicy = 'disabled' | 'allowlist' | 'pairing';

function resolveEffectiveDmPolicy(): DmPolicy {
  const stored = goromboPersistenceRuntime.sessionDatabase.getTelegramSetting('dmPolicy');
  if (stored === 'disabled' || stored === 'allowlist' || stored === 'pairing') {
    return stored;
  }
  return 'pairing';
}

function getApprovedUserIds(): string[] {
  const raw = process.env.TELEGRAM_APPROVED_USER_IDS;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return [];
  }
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function getBotUsername(): string {
  return process.env.TELEGRAM_BOT_USERNAME ?? '';
}

function getMentionPatterns(): string[] {
  const raw = process.env.TELEGRAM_MENTION_PATTERNS;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return [];
  }
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function shouldProcessUpdate(message: Message): { allowed: true } | { allowed: false; reason: string } {
  const chatType = message.chat.type;
  const chatId = String(message.chat.id);
  const senderId = String(message.from?.id ?? '');

  const dmPolicy = resolveEffectiveDmPolicy();

  if (dmPolicy === 'disabled') {
    return { allowed: false, reason: 'dm_policy_disabled' };
  }

  const approvedUserIds = getApprovedUserIds();
  const isAllowed =
    goromboPersistenceRuntime.sessionDatabase.isTelegramUserAllowed(senderId) ||
    approvedUserIds.includes(senderId);

  if (chatType === 'private') {
    if (!isAllowed) {
      if (dmPolicy === 'allowlist') {
        return { allowed: false, reason: 'dm_allowlist' };
      }
      return { allowed: false, reason: 'dm_pairing_required' };
    }
  } else if (chatType === 'group' || chatType === 'supergroup') {
    const group = goromboPersistenceRuntime.sessionDatabase.getTelegramGroup(chatId);
    if (!group) {
      return { allowed: false, reason: 'group_not_configured' };
    }

    const botUsername = getBotUsername();
    const mentionPatterns = getMentionPatterns();
    if (group.requireMention && !isMentioned(message, botUsername, mentionPatterns)) {
      return { allowed: false, reason: 'group_mention_required' };
    }

    if (group.allowFrom.length > 0 && !group.allowFrom.includes(senderId)) {
      return { allowed: false, reason: 'group_allowlist' };
    }

    if (!isAllowed) {
      return { allowed: false, reason: 'user_not_allowed' };
    }
  } else {
    return { allowed: false, reason: 'unsupported_chat_type' };
  }

  return { allowed: true };
}

import type { TelegramChannel } from '@flue/telegram';

function getTelegramWebhookSecret(): string {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN;
  if (secret) {
    return secret;
  }
  if (isTestMode()) {
    return 'test-webhook-secret';
  }
  if (isTelegramConfigured()) {
    throw new Error(
      'TELEGRAM_WEBHOOK_SECRET_TOKEN environment variable is required for webhook authentication when Telegram is configured. Set it to enable Telegram, or remove TELEGRAM_BOT_TOKEN to run without Telegram (TUI/HTTP only).',
    );
  }
  // Telegram not configured: use a random non-deterministic secret so
  // the channel can still be constructed (Flue requires it) but webhook
  // requests will never authenticate even if they reach this instance.
  return `disabled-${crypto.randomUUID()}`;
}

let cachedChannel: TelegramChannel | undefined;

function getOrCreateTelegramChannel(): TelegramChannel {
  if (!cachedChannel) {
    cachedChannel = createTelegramChannel({
      secretToken: getTelegramWebhookSecret(),

      async webhook({ c, update }) {
        if (!isTelegramConfigured()) {
          return c.json({ error: 'Telegram is not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET_TOKEN to enable it.' }, 503);
        }

        markTelegramUpdateReceived();

        const incoming = update.message ?? update.channel_post ?? update.business_message;
        if (incoming) {
          await handleIncomingMessage(incoming, update);
          return;
        }

        if (update.callback_query) {
          await handleCallbackQuery(update.callback_query, update);
          return;
        }
      },
    });
  }
  return cachedChannel;
}

export function getTelegramChannel(): TelegramChannel | undefined {
  return isTelegramConfigured() ? getOrCreateTelegramChannel() : undefined;
}

export const channel: TelegramChannel = getOrCreateTelegramChannel();

/**
 * Project-owned outbound Telegram reply tool. The channel owns inbound ingress;
 * this tool sends replies scoped by the trusted persisted eventId.
 */
export const telegramReplyTool = defineTool({
  name: 'telegram_reply',
  description:
    'Reply to the Telegram conversation that triggered the current event. Pass the eventId from the trusted Telegram chat context.',
  parameters: v.object({
    eventId: v.string(),
    text: v.string(),
    format: v.optional(v.picklist(['text', 'markdownv2'])),
  }),
  execute: async ({ eventId, text, format }) => {
    const event = goromboPersistenceRuntime.sessionDatabase.getNormalizedMessageEvent(eventId);
    if (!event) {
      throw new Error('telegram_reply requires a trusted eventId persisted by chat ingress.');
    }
    if (event.connector !== 'telegram') {
      throw new Error('telegram_reply can only respond to Telegram events.');
    }

    const chatId = event.conversation.id;
    const rawMessage = event.raw as { message?: { message_id?: number } } | undefined;
    const replyTo = rawMessage?.message?.message_id != null ? Number(rawMessage.message.message_id) : undefined;
    const parseMode = format === 'markdownv2' ? ('MarkdownV2' as const) : undefined;

    await client.sendMessage(chatId, String(text), {
      reply_to_message_id: Number.isFinite(replyTo) ? replyTo : undefined,
      parse_mode: parseMode,
    });

    return 'sent';
  },
});

async function handleIncomingMessage(incoming: Message, update: Update) {
  const accessCheck = shouldProcessUpdate(incoming);
  if (!accessCheck.allowed) {
    return;
  }

  const normalized = normalizeTelegramUpdate({
    update_id: update.update_id,
    message: incoming as unknown as Parameters<typeof normalizeTelegramUpdate>[0]['message'],
  });

  const sessionResolution = resolveChatSession({ event: normalized });
  goromboPersistenceRuntime.sessionDatabase.recordNormalizedMessageEvent({
    event: normalized,
    sessionId: sessionResolution.sessionId,
    deliveryKind: 'direct-agent',
  });

  const activeChannel = getOrCreateTelegramChannel();

  const harness = await dispatch(orchestratorAgent, {
    id: activeChannel.conversationKey(conversationFromMessage(incoming)),
    input: {
      type: 'telegram.message',
      updateId: update.update_id,
      message: incoming,
      prompt: createChatPrompt(normalized),
    },
  });

  return harness;
}

async function handleCallbackQuery(query: NonNullable<Update['callback_query']>, _update: Update) {
  const data = query.data;
  if (!data) {
    await client.answerCallbackQuery(query.id);
    return;
  }

  const parsed = parseApprovalCallback(data);
  if (!parsed) {
    await client.answerCallbackQuery(query.id);
    return;
  }

  const approvalIngress = createTelegramApprovalIngress();
  if (!approvalIngress) {
    await client.answerCallbackQuery(query.id, { text: 'Approval ingress is not configured.' });
    return;
  }

  const userId = String(query.from.id);
  const adminUserIds = readTelegramAdminUserIds();
  const role = adminUserIds.includes(userId) ? 'admin' : 'operator';

  try {
    const record = await approvalIngress.getApprovalRequest(parsed.requestId);
    if (!record) {
      await client.answerCallbackQuery(query.id, { text: 'Approval request not found.' });
      return;
    }
    if (record.status !== 'pending') {
      await client.answerCallbackQuery(query.id, { text: 'This approval has already been resolved.' });
      return;
    }

    await approvalIngress.recordApprovalDecision({
      requestId: parsed.requestId,
      approved: parsed.approved,
      decidedBy: userId,
      reason: `Telegram ${parsed.approved ? 'approve' : 'deny'} button`,
      principal: { id: userId, roles: [role] },
    });

    const resolved = await approvalIngress.getApprovalRequest(parsed.requestId);
    if (resolved && query.message) {
      const messageId = query.message.message_id;
      await client.editMessageText(query.message.chat.id, messageId, buildApprovalResolvedMessage(resolved), {
        reply_markup: { inline_keyboard: [] },
      });
    }

    await client.answerCallbackQuery(query.id, { text: `Approval ${parsed.approved ? 'approved' : 'denied'}.` });
  } catch (err) {
    await client.answerCallbackQuery(query.id, { text: 'Failed to record decision.' });
  }
}

function createTelegramApprovalIngress() {
  const approvalRoot = process.env.GOROMBO_APPROVAL_ROOT;
  if (!approvalRoot) {
    return undefined;
  }
  const approvalService = createSharedCodingApprovalService({ GOROMBO_APPROVAL_ROOT: approvalRoot });
  return createApprovalIngress({
    approvalService,
    bindingStore: createFileApprovalBindingStore(approvalRoot),
  });
}

export function resolveTelegramApprovalPrincipal(userId: string, adminUserIds: string[]): 'admin' | 'operator' {
  return adminUserIds.includes(userId) ? 'admin' : 'operator';
}

function readTelegramAdminUserIds(): string[] {
  const raw = process.env.TELEGRAM_ADMIN_USER_IDS;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return [];
  }
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function conversationFromMessage(message: Message): TelegramConversationRef {
  return {
    type: 'chat',
    chatId: message.chat.id,
    messageThreadId: message.message_thread_id,
    directMessagesTopicId: message.direct_messages_topic?.topic_id,
  };
}
