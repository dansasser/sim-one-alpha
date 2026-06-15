import { Type, defineTool } from '@flue/runtime';
import { TelegramApiClient } from '../connectors/telegram/telegram-api.js';
import { goromboPersistenceRuntime } from '../db.js';
import type { NormalizedMessageEvent } from '../types/index.js';

export interface TelegramReplyToolInput {
  eventId: string;
  text: string;
  replyTo?: string;
  format?: 'text' | 'markdownv2';
}

export function createTelegramReplyTool(token: string) {
  const api = new TelegramApiClient(token);

  return defineTool({
    name: 'telegram_reply',
    description: 'Reply to the Telegram conversation that triggered the current event. Use this when the orchestrator response should go back to Telegram.',
    parameters: Type.Object({
      eventId: Type.String(),
      text: Type.String(),
      replyTo: Type.Optional(Type.String()),
      format: Type.Optional(Type.String({ enum: ['text', 'markdownv2'] })),
    }),
    execute: async (input) => {
      const event = getTrustedTelegramEvent(input.eventId as string);
      const chatId = event.conversation.id;
      const replyTo = input.replyTo != null ? Number(input.replyTo) : undefined;
      const parseMode = input.format === 'markdownv2' ? 'MarkdownV2' as const : undefined;

      await api.sendMessage(chatId, String(input.text), {
        replyTo: Number.isFinite(replyTo) ? replyTo : undefined,
        parseMode,
      });

      return 'sent';
    },
  });
}

export function readTelegramBotToken(env: Record<string, unknown> | undefined): string {
  const mergedEnv = {
    ...process.env,
    ...(env ?? {}),
  };
  return typeof mergedEnv.TELEGRAM_BOT_TOKEN === 'string' && mergedEnv.TELEGRAM_BOT_TOKEN.trim().length > 0
    ? mergedEnv.TELEGRAM_BOT_TOKEN.trim()
    : '';
}

function getTrustedTelegramEvent(eventId: string): NormalizedMessageEvent {
  const event = goromboPersistenceRuntime.sessionDatabase.getNormalizedMessageEvent(eventId);
  if (!event) {
    throw new Error(`telegram_reply requires a trusted eventId persisted by chat ingress.`);
  }
  if (event.connector !== 'telegram') {
    throw new Error(`telegram_reply can only respond to Telegram events.`);
  }
  return event;
}
