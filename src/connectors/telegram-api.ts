import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';
const MAX_CHUNK_LIMIT = 4096;

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
  photo?: Array<{ file_id: string; file_unique_id: string; width: number; height: number }>;
  document?: { file_id: string; file_unique_id: string; file_name?: string; mime_type?: string; file_size?: number };
  voice?: { file_id: string; file_unique_id: string; mime_type?: string; file_size?: number };
  audio?: { file_id: string; file_unique_id: string; file_name?: string; title?: string; mime_type?: string; file_size?: number };
  video?: { file_id: string; file_unique_id: string; file_name?: string; mime_type?: string; file_size?: number };
  video_note?: { file_id: string; file_unique_id: string; file_size?: number };
  sticker?: { file_id: string; file_unique_id: string; emoji?: string; file_size?: number };
  reply_to_message?: { message_id: number; from?: { username?: string } };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
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

  async getMe(): Promise<TelegramUser> {
    const response = await fetch(this.url('getMe'));
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
  } = {}): Promise<{ message_id: number }> {
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

      const response = await fetch(this.url('sendMessage'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const body = (await response.json()) as TelegramApiResponse<{ message_id: number }>;
      if (!body.ok) {
        throw new Error(`Telegram sendMessage failed: ${body.error_code} ${body.description}`);
      }
      lastMessageId = body.result.message_id;
    }

    return { message_id: lastMessageId };
  }

  async getFile(fileId: string): Promise<TelegramFile> {
    const response = await fetch(this.url('getFile'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file_id: fileId }),
    });
    const body = (await response.json()) as TelegramApiResponse<TelegramFile>;
    if (!body.ok) {
      throw new Error(`Telegram getFile failed: ${body.error_code} ${body.description}`);
    }
    return body.result;
  }

  async downloadFile(file: TelegramFile, inboxDir: string): Promise<string | undefined> {
    if (!file.file_path) {
      return undefined;
    }

    const url = `https://api.telegram.org/file/bot${this.token}/${file.file_path}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Telegram file download failed: HTTP ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
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
  const entities = message.entities ?? [];

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
    try {
      if (new RegExp(pattern, 'i').test(text)) {
        return true;
      }
    } catch {
      // skip invalid user-supplied regex
    }
  }

  return false;
}
