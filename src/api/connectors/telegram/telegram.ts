import type { NormalizedMessageEvent } from '../../../core/types/index.js';
import { createEventId } from '../../../api/connectors/base.js';

export interface TelegramUpdateLike {
  update_id?: number;
  message?: {
    message_id?: number;
    message_thread_id?: number;
    text?: string;
    chat?: {
      id?: number | string;
    };
    from?: {
      id?: number | string;
      first_name?: string;
      username?: string;
    };
  };
}

export function normalizeTelegramUpdate(update: TelegramUpdateLike): NormalizedMessageEvent {
  const message = update.message;
  const actorId = message?.from?.id ? String(message.from.id) : 'telegram:unknown-user';
  const conversationId = message?.chat?.id ? String(message.chat.id) : 'telegram:unknown-chat';

  return {
    id: update.update_id ? `telegram:${update.update_id}` : createEventId('telegram'),
    connector: 'telegram',
    kind: 'chat.message',
    text: message?.text ?? '',
    receivedAt: new Date().toISOString(),
    actor: {
      id: actorId,
      displayName: message?.from?.username ?? message?.from?.first_name,
    },
    conversation: {
      id: conversationId,
      threadId: message?.message_thread_id ? String(message.message_thread_id) : undefined,
    },
    raw: update,
  };
}
