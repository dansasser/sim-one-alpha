import { dispatch, defineTool } from '@flue/runtime';
import { createTelegramChannel, type TelegramConversationRef } from '@flue/telegram';
import { Api } from 'grammy';
import type { Message, Update } from 'grammy/types';
import orchestratorAgent from '../agents/orchestrator.js';
import {
  createApprovalIngress,
  createFileApprovalBindingStore,
} from '../ingress/approval-ingress.js';
import { createSharedCodingApprovalService } from '../approvals/shared-approval-service.js';
import { goromboPersistenceRuntime } from '../db.js';
import { resolveChatSession } from '../session/session-routing.js';
import { createChatPrompt } from '../routes/chat-prompt.js';
import { normalizeTelegramUpdate } from '../connectors/telegram/telegram.js';
import { buildApprovalResolvedMessage, parseApprovalCallback } from '../connectors/telegram/approval-ui/index.js';
import { markTelegramUpdateReceived } from '../connectors/telegram/telegram-state.js';
import type { NormalizedMessageEvent } from '../types/index.js';
import * as v from 'valibot';

export const client = new Api(process.env.TELEGRAM_BOT_TOKEN ?? 'placeholder-token');

function getTelegramWebhookSecret(): string {
  return process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN ?? 'placeholder-secret';
}


import type { TelegramChannel } from '@flue/telegram';

export const channel: TelegramChannel = createTelegramChannel({
  secretToken: getTelegramWebhookSecret(),

  // Path: /channels/telegram/webhook
  async webhook({ c, update }) {
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

/**
 * Builds the grammY outbound message tool bound to the active Telegram conversation.
 * Flue's channel owns inbound ingress; this project-owned tool handles outbound replies.
 */
export function createTelegramReplyTool(event: NormalizedMessageEvent) {
  const chatId = event.conversation.id;
  const rawMessage = event.raw as { message?: { message_id?: number } } | undefined;
  const replyTo = rawMessage?.message?.message_id != null ? Number(rawMessage.message.message_id) : undefined;

  return defineTool({
    name: 'telegram_reply',
    description: 'Reply to the Telegram conversation that triggered the current event.',
    parameters: v.object({
      text: v.string(),
      format: v.optional(v.picklist(['text', 'markdownv2'])),
    }),
    execute: async ({ text, format }) => {
      const parseMode = format === 'markdownv2' ? 'MarkdownV2' as const : undefined;
      await client.sendMessage(chatId, String(text), {
        reply_to_message_id: Number.isFinite(replyTo) ? replyTo : undefined,
        parse_mode: parseMode,
      });
      return 'sent';
    },
  });
}

async function handleIncomingMessage(incoming: Message, update: Update) {
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

  const harness = await dispatch(orchestratorAgent, {
    id: channel.conversationKey(conversationFromMessage(incoming)),
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
