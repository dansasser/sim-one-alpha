import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';
const MAX_CHUNK_LIMIT = 4096;
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024; // 50 MiB

export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

export interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  text?: string;
  chat: {
    id: number;
    type?: string;
  };
  from?: {
    id: number;
    first_name?: string;
    username?: string;
    is_bot?: boolean;
  };
  entities?: Array<{
    type: string;
    offset: number;
    length: number;
  }>;
  caption?: string;
  caption_entities?: Array<{
    type: string;
    offset: number;
    length: number;
  }>;
  photo?: Array<{ file_id: string; file_unique_id: string; width: number; height: number }>;
  document?: { file_id: string; file_unique_id: string; file_name?: string; mime_type?: string; file_size?: number };
  voice?: { file_id: string; file_unique_id: string; mime_type?: string; file_size?: number };
  audio?: { file_id: string; file_unique_id: string; file_name?: string; title?: string; mime_type?: string; file_size?: number };
  video?: { file_id: string; file_unique_id: string; file_name?: string; mime_type?: string; file_size?: number };
  video_note?: { file_id: string; file_unique_id: string; file_size?: number };
  sticker?: { file_id: string; file_unique_id: string; emoji?: string; file_size?: number };
  reply_to_message?: { message_id: number; from?: { username?: string } };
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
  inline_message_id?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface TelegramApiError {
  ok: false;
  error_code: number;
  description: string;
}

export interface TelegramApiSuccess<T> {
  ok: true;
  result: T;
}

export type TelegramApiResponse<T> = TelegramApiSuccess<T> | TelegramApiError;

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export class TelegramApiClient {
  constructor(private readonly token: string) {}

  private url(method: string): string {
    return `${TELEGRAM_API_BASE}${this.token}/${method}`;
  }

  async getMe(signal?: AbortSignal): Promise<TelegramUser> {
    const response = await fetch(this.url('getMe'), { signal });
    const body = (await response.json()) as TelegramApiResponse<TelegramUser>;
    if (!body.ok) {
      throw new Error(`Telegram getMe failed: ${body.error_code} ${body.description}`);
    }
    return body.result;
  }

  async getUpdates(offset: number, limit = 100, timeout = 30, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    const response = await fetch(this.url('getUpdates'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ offset, limit, timeout }),
      signal,
    });
    const body = (await response.json()) as TelegramApiResponse<TelegramUpdate[]>;
    if (!body.ok) {
      throw new Error(`Telegram getUpdates failed: ${body.error_code} ${body.description}`);
    }
    return body.result;
  }

  async sendMessage(chatId: string | number, text: string, options: {
    replyTo?: number;
    parseMode?: 'MarkdownV2';
    replyMarkup?: InlineKeyboardMarkup;
  } = {}, signal?: AbortSignal): Promise<{ message_id: number }> {
    const chunks = chunkTelegramText(text);
    let lastMessageId = 0;

    for (let i = 0; i < chunks.length; i++) {
      const payload: Record<string, unknown> = {
        chat_id: chatId,
        text: chunks[i],
      };

      if (options.replyTo != null && i === 0) {
        payload.reply_parameters = { message_id: options.replyTo };
      }

      if (options.parseMode === 'MarkdownV2') {
        payload.parse_mode = 'MarkdownV2';
      }

      if (options.replyMarkup != null && i === chunks.length - 1) {
        payload.reply_markup = options.replyMarkup;
      }

      const response = await fetch(this.url('sendMessage'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      });

      const body = (await response.json()) as TelegramApiResponse<{ message_id: number }>;
      if (!body.ok) {
        throw new Error(`Telegram sendMessage failed: ${body.error_code} ${body.description}`);
      }
      lastMessageId = body.result.message_id;
    }

    return { message_id: lastMessageId };
  }

  async sendInlineKeyboard(
    chatId: string | number,
    text: string,
    buttons: InlineKeyboardButton[][],
    options: {
      replyTo?: number;
      parseMode?: 'MarkdownV2';
    } = {},
    signal?: AbortSignal,
  ): Promise<{ message_id: number }> {
    return this.sendMessage(chatId, text, { ...options, replyMarkup: { inline_keyboard: buttons } }, signal);
  }

  async editMessageText(
    chatId: string | number,
    messageId: number,
    text: string,
    options: {
      parseMode?: 'MarkdownV2';
      replyMarkup?: InlineKeyboardMarkup;
    } = {},
    signal?: AbortSignal,
  ): Promise<{ message_id: number }> {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text,
    };

    if (options.parseMode === 'MarkdownV2') {
      payload.parse_mode = 'MarkdownV2';
    }

    if (options.replyMarkup != null) {
      payload.reply_markup = options.replyMarkup;
    }

    const response = await fetch(this.url('editMessageText'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });

    const body = (await response.json()) as TelegramApiResponse<{ message_id: number }>;
    if (!body.ok) {
      throw new Error(`Telegram editMessageText failed: ${body.error_code} ${body.description}`);
    }
    return body.result;
  }

  async answerCallbackQuery(
    callbackQueryId: string,
    options: {
      text?: string;
      showAlert?: boolean;
      url?: string;
    } = {},
    signal?: AbortSignal,
  ): Promise<void> {
    const payload: Record<string, unknown> = {
      callback_query_id: callbackQueryId,
    };

    if (options.text != null) {
      payload.text = options.text;
    }
    if (options.showAlert != null) {
      payload.show_alert = options.showAlert;
    }
    if (options.url != null) {
      payload.url = options.url;
    }

    const response = await fetch(this.url('answerCallbackQuery'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });

    const body = (await response.json()) as TelegramApiResponse<boolean>;
    if (!body.ok) {
      throw new Error(`Telegram answerCallbackQuery failed: ${body.error_code} ${body.description}`);
    }
  }

  async getFile(fileId: string, signal?: AbortSignal): Promise<TelegramFile> {
    const response = await fetch(this.url('getFile'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file_id: fileId }),
      signal,
    });
    const body = (await response.json()) as TelegramApiResponse<TelegramFile>;
    if (!body.ok) {
      throw new Error(`Telegram getFile failed: ${body.error_code} ${body.description}`);
    }
    return body.result;
  }

  async downloadFile(file: TelegramFile, inboxDir: string, signal?: AbortSignal, maxBytes = MAX_DOWNLOAD_BYTES): Promise<string | undefined> {
    if (!file.file_path) {
      return undefined;
    }

    const url = `https://api.telegram.org/file/bot${this.token}/${file.file_path}`;
    const response = await fetch(url, { signal });
    if (!response.ok) {
      throw new Error(`Telegram file download failed: HTTP ${response.status}`);
    }

    const contentLength = response.headers.get('content-length');
    if (contentLength) {
      const length = Number(contentLength);
      if (Number.isFinite(length) && length > maxBytes) {
        throw new Error(`Telegram file too large: ${length} bytes exceeds ${maxBytes} bytes`);
      }
    }

    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > maxBytes) {
      throw new Error(`Telegram file body too large: ${arrayBuffer.byteLength} bytes exceeds ${maxBytes} bytes`);
    }

    const buffer = Buffer.from(arrayBuffer);
    const rawExt = file.file_path.includes('.') ? file.file_path.split('.').pop()! : 'bin';
    const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin';
    const uniqueId = (file.file_unique_id ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'dl';
    const path = join(inboxDir, `${Date.now()}-${uniqueId}.${ext}`);

    mkdirSync(inboxDir, { recursive: true });
    await writeFile(path, buffer);
    return path;
  }
}

async function writeFile(path: string, buffer: Buffer): Promise<void> {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, buffer);
}

export function chunkTelegramText(text: string, limit = MAX_CHUNK_LIMIT): string[] {
  if (text.length <= limit) {
    return [text];
  }

  const chunks: string[] = [];
  let rest = text;

  while (rest.length > limit) {
    let cut = limit;
    const para = rest.lastIndexOf('\n\n', limit);
    const line = rest.lastIndexOf('\n', limit);
    const space = rest.lastIndexOf(' ', limit);
    cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit;

    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }

  if (rest) {
    chunks.push(rest);
  }

  return chunks;
}

export function generatePairingCode(): string {
  return randomBytes(3).toString('hex');
}

export function isMentioned(message: TelegramMessage, botUsername: string, mentionPatterns?: string[]): boolean {
  const text = message.text ?? message.caption ?? '';
  const entities = message.caption_entities ?? message.entities ?? [];

  for (const entity of entities) {
    if (entity.type === 'mention') {
      const mentioned = text.slice(entity.offset, entity.offset + entity.length);
      if (mentioned.toLowerCase() === `@${botUsername}`.toLowerCase()) {
        return true;
      }
    }
    if (entity.type === 'text_mention' && 'user' in entity && (entity as unknown as { user?: { is_bot?: boolean; username?: string } }).user?.username === botUsername) {
      return true;
    }
  }

  if (message.reply_to_message?.from?.username === botUsername) {
    return true;
  }

  for (const pattern of mentionPatterns ?? []) {
    const normalizedPattern = pattern.trim().toLowerCase();
    if (!normalizedPattern) {
      continue;
    }

    const normalizedText = ` ${text.toLowerCase()} `;
    const wordBoundaryBefore = normalizedText.includes(` ${normalizedPattern}`);
    const wordBoundaryAfter = normalizedText.includes(`${normalizedPattern} `);
    if (wordBoundaryBefore || wordBoundaryAfter || normalizedText.trim() === normalizedPattern) {
      return true;
    }
  }

  return false;
}
