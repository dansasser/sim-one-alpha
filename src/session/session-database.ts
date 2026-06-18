import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SessionData } from '@flue/runtime/adapter';
import type { EmbeddingClient } from '../rag/embeddings.js';
import { getOnnxEmbeddingDimensions } from '../embeddings/index.js';
import type { VectorStore, VectorRecord } from '../rag/vector/index.js';
import type { NormalizedMessageEvent } from '../types/index.js';
import { estimateTextTokens } from './context-budget.js';
import { directAgentHarnessName, directAgentSessionName } from './direct-agent-session.js';
import { parseFlueSessionStorageKey } from './flue-session-store.js';

export const defaultSessionDatabasePath = '.gorombo/db/sessions.sqlite';

export interface ChatSessionRecord {
  sessionId: string;
  origin: string;
  actorId?: string;
  conversationId?: string;
  threadId?: string;
  title?: string;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EnsureChatSessionInput {
  sessionId: string;
  origin: string;
  actorId?: string;
  conversationId?: string;
  threadId?: string;
  title?: string;
}

export interface CreateChatSessionInput extends Omit<EnsureChatSessionInput, 'sessionId'> {
  sessionId?: string;
}

export interface ActiveSessionLookup {
  surface: string;
  connector: string;
  actorId?: string;
  conversationId?: string;
  threadId?: string;
}

export interface SessionMemorySearchInput {
  text: string;
  limit?: number;
  actorId?: string;
  conversationId?: string;
  sessionId?: string;
}

export interface SessionMemoryRecord {
  id: string;
  storageKey: string;
  harnessName: string;
  sessionName: string;
  entryId: string;
  kind: string;
  role?: string;
  actorId?: string;
  conversationId?: string;
  threadId?: string;
  title: string;
  content: string;
  score: number;
  tokenEstimate: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface RecordNormalizedMessageEventInput {
  event: NormalizedMessageEvent;
  sessionId?: string;
  deliveryKind?: string;
  deliveryId?: string;
  acceptedAt?: string;
}


export interface CreateImageArtifactInput {
  artifactId: string;
  eventId: string;
  prompt: string;
  modelId: string;
  modelName: string;
  aspectRatio?: string;
  seed?: number;
  negativePrompt?: string;
  providerOptions: Record<string, unknown>;
  sourceUrl?: string;
  filePath: string;
  fileName: string;
  mimeType: string;
  fileSizeBytes: number;
  referenceImageUrls?: string[];
}

export interface ListImageArtifactsInput {
  eventId?: string;
  limit?: number;
  after?: string;
}

export interface RecordSessionMemoryChunkInput {
  storageKey: string;
  harnessName: string;
  sessionName: string;
  entryId: string;
  kind: string;
  role?: string;
  actorId?: string;
  conversationId?: string;
  threadId?: string;
  title: string;
  content: string;
  tokenEstimate: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export class GoromboSessionDatabase {
  private readonly database: DatabaseSync;
  private readonly vectorStore?: VectorStore;
  private readonly embeddingClient?: EmbeddingClient;
  private pendingStorageOps = new Map<string, Promise<unknown>>();

  constructor(
    readonly filePath = defaultSessionDatabasePath,
    options: { vectorStore?: VectorStore; embeddingClient?: EmbeddingClient } = {},
  ) {
    const resolved = resolveRuntimePath(filePath);
    this.vectorStore = options.vectorStore;
    this.embeddingClient = options.embeddingClient;
    mkdirSync(dirname(resolved), { recursive: true });
    this.database = new DatabaseSync(resolved, { timeout: 5_000 });
    this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
    this.migrate();
  }

  close(): void {
    this.database.close();
  }

  async recordFlueSession(storageKey: string, data: SessionData): Promise<void> {
    const parts = parseFlueSessionStorageKey(storageKey);
    if (!parts) {
      return;
    }

    const updatedAt = data.updatedAt || new Date().toISOString();
    this.database
      .prepare(
        `INSERT OR REPLACE INTO flue_session_index
         (storage_key, instance_id, harness_name, session_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(storageKey, parts.instanceId, parts.harnessName, parts.sessionName, data.createdAt, updatedAt);

    this.database
      .prepare(
        `INSERT INTO flue_instance_sessions
         (instance_id, harness_name, session_name, latest_storage_key, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(instance_id, harness_name, session_name) DO UPDATE SET
           latest_storage_key = excluded.latest_storage_key,
           updated_at = excluded.updated_at
         WHERE excluded.updated_at >= flue_instance_sessions.updated_at`,
      )
      .run(parts.instanceId, parts.harnessName, parts.sessionName, storageKey, updatedAt);

    if (!this.isDirectAgentChatSession(parts.instanceId, parts.harnessName, parts.sessionName)) {
      this.database
        .prepare(
          `INSERT INTO flue_logical_sessions
           (harness_name, session_name, latest_storage_key, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(harness_name, session_name) DO UPDATE SET
             latest_storage_key = excluded.latest_storage_key,
             updated_at = excluded.updated_at
           WHERE excluded.updated_at >= flue_logical_sessions.updated_at`,
        )
        .run(parts.harnessName, parts.sessionName, storageKey, updatedAt);
    }

    await this.indexSessionMemory(storageKey, parts.harnessName, parts.sessionName, data);
  }

  async deleteFlueSession(storageKey: string): Promise<void> {
    const parts = parseFlueSessionStorageKey(storageKey);
    if (!parts) {
      return;
    }

    this.database.prepare(`DELETE FROM flue_session_index WHERE storage_key = ?`).run(storageKey);
    this.deleteSessionMemoryByStorageKey(storageKey);
    this.deleteInstanceSessionIndex(parts.instanceId, parts.harnessName, parts.sessionName, storageKey);

    await this.deleteSessionMemoryVectorsFinished(storageKey);


    if (!this.isDirectAgentChatSession(parts.instanceId, parts.harnessName, parts.sessionName)) {
      const latest = this.getLatestStorageKey(parts.harnessName, parts.sessionName);
      if (latest === storageKey) {
        const replacement = this.getMostRecentIndexedStorageKey(parts.harnessName, parts.sessionName);
        if (replacement) {
          this.database
            .prepare(
              `UPDATE flue_logical_sessions
               SET latest_storage_key = ?, updated_at = ?
               WHERE harness_name = ? AND session_name = ?`,
            )
            .run(replacement.storageKey, replacement.updatedAt, parts.harnessName, parts.sessionName);
        } else {
          this.database
            .prepare(`DELETE FROM flue_logical_sessions WHERE harness_name = ? AND session_name = ?`)
            .run(parts.harnessName, parts.sessionName);
        }
      }
    }
  }

  getLatestStorageKeyForInstance(instanceId: string, harnessName: string, sessionName: string): string | null {
    const row = this.database
      .prepare(
        `SELECT latest_storage_key
         FROM flue_instance_sessions
         WHERE instance_id = ? AND harness_name = ? AND session_name = ?`,
      )
      .get(instanceId, harnessName, sessionName) as LatestSessionRow | undefined;

    return typeof row?.latest_storage_key === 'string' ? row.latest_storage_key : null;
  }

  getLatestStorageKey(harnessName: string, sessionName: string): string | null {
    const row = this.database
      .prepare(
        `SELECT latest_storage_key
         FROM flue_logical_sessions
         WHERE harness_name = ? AND session_name = ?`,
      )
      .get(harnessName, sessionName) as LatestSessionRow | undefined;

    return typeof row?.latest_storage_key === 'string' ? row.latest_storage_key : null;
  }

  private getMostRecentIndexedStorageKey(harnessName: string, sessionName: string): {
    storageKey: string;
    updatedAt: string;
  } | null {
    const row = this.database
      .prepare(
        `SELECT storage_key, updated_at
         FROM flue_session_index
         WHERE harness_name = ? AND session_name = ?
         ORDER BY updated_at DESC, created_at DESC, storage_key DESC
         LIMIT 1`,
      )
      .get(harnessName, sessionName) as IndexedSessionRow | undefined;

    return row ? { storageKey: row.storage_key, updatedAt: row.updated_at } : null;
  }

  createChatSession(input: CreateChatSessionInput): ChatSessionRecord {
    return this.ensureChatSession({
      ...input,
      sessionId: input.sessionId ?? createSessionId(input.origin),
    });
  }

  ensureChatSession(input: EnsureChatSessionInput): ChatSessionRecord {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO chat_sessions
         (session_id, origin, actor_id, conversation_id, thread_id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           actor_id = COALESCE(excluded.actor_id, chat_sessions.actor_id),
           conversation_id = COALESCE(excluded.conversation_id, chat_sessions.conversation_id),
           thread_id = COALESCE(excluded.thread_id, chat_sessions.thread_id),
           title = COALESCE(excluded.title, chat_sessions.title),
           updated_at = excluded.updated_at`,
      )
      .run(
        input.sessionId,
        input.origin,
        input.actorId ?? null,
        input.conversationId ?? null,
        input.threadId ?? null,
        input.title ?? null,
        now,
        now,
      );

    const record = this.getChatSession(input.sessionId);
    if (!record) {
      throw new Error(`Failed to create chat session ${input.sessionId}`);
    }
    return record;
  }

  getChatSession(sessionId: string): ChatSessionRecord | null {
    const row = this.database
      .prepare(
        `SELECT session_id, origin, actor_id, conversation_id, thread_id, title, archived_at, created_at, updated_at
         FROM chat_sessions
         WHERE session_id = ?`,
      )
      .get(sessionId) as ChatSessionRow | undefined;

    return row ? toChatSessionRecord(row) : null;
  }

  deleteChatSession(sessionId: string): void {
    this.database.prepare(`DELETE FROM active_sessions WHERE session_id = ?`).run(sessionId);
    this.database.prepare(`DELETE FROM chat_sessions WHERE session_id = ?`).run(sessionId);
  }

  listChatSessions(limit = 50): ChatSessionRecord[] {
    const rows = this.database
      .prepare(
        `SELECT session_id, origin, actor_id, conversation_id, thread_id, title, archived_at, created_at, updated_at
         FROM chat_sessions
         WHERE archived_at IS NULL
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(Math.max(1, Math.min(200, Math.floor(limit)))) as unknown as ChatSessionRow[];

    return rows.map(toChatSessionRecord);
  }

  touchChatSession(sessionId: string, title?: string): void {
    this.database
      .prepare(
        `UPDATE chat_sessions
         SET updated_at = ?, title = COALESCE(?, title)
         WHERE session_id = ?`,
      )
      .run(new Date().toISOString(), title ?? null, sessionId);
  }

  recordNormalizedMessageEvent(input: RecordNormalizedMessageEventInput): void {
    const now = new Date().toISOString();
    const event = input.event;

    this.database
      .prepare(
        `INSERT INTO normalized_message_events
         (event_id, session_id, connector, message_kind, text, received_at, actor_id, actor_display_name, conversation_id, thread_id, client_id, project_id, workflow, task, delivery_kind, delivery_id, accepted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(event_id) DO UPDATE SET
           session_id = COALESCE(excluded.session_id, normalized_message_events.session_id),
           connector = excluded.connector,
           message_kind = excluded.message_kind,
           text = excluded.text,
           received_at = excluded.received_at,
           actor_id = excluded.actor_id,
           actor_display_name = excluded.actor_display_name,
           conversation_id = excluded.conversation_id,
           thread_id = excluded.thread_id,
           client_id = excluded.client_id,
           project_id = excluded.project_id,
           workflow = excluded.workflow,
           task = excluded.task,
           delivery_kind = COALESCE(excluded.delivery_kind, normalized_message_events.delivery_kind),
           delivery_id = COALESCE(excluded.delivery_id, normalized_message_events.delivery_id),
           accepted_at = COALESCE(excluded.accepted_at, normalized_message_events.accepted_at),
           updated_at = excluded.updated_at`,
      )
      .run(
        event.id,
        input.sessionId ?? null,
        event.connector,
        event.kind,
        event.text,
        event.receivedAt,
        event.actor.id,
        event.actor.displayName ?? null,
        event.conversation.id,
        event.conversation.threadId ?? null,
        event.context?.clientId ?? null,
        event.context?.projectId ?? null,
        event.context?.workflow ?? null,
        event.context?.task ?? null,
        input.deliveryKind ?? null,
        input.deliveryId ?? null,
        input.acceptedAt ?? null,
        now,
        now,
      );
  }

  getNormalizedMessageEvent(eventId: string): NormalizedMessageEvent | null {
    const row = this.database
      .prepare(
        `SELECT event_id, connector, message_kind, text, received_at, actor_id, actor_display_name, conversation_id, thread_id, client_id, project_id, workflow, task, delivery_kind, delivery_id, accepted_at
         FROM normalized_message_events
         WHERE event_id = ?`,
      )
      .get(eventId) as NormalizedMessageEventRow | undefined;

    return row ? toNormalizedMessageEvent(row) : null;
  }


  createImageArtifact(input: CreateImageArtifactInput): void {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO image_artifacts
         (artifact_id, event_id, prompt, model_id, model_name, aspect_ratio, seed, negative_prompt,
          provider_options_json, source_url, file_path, file_name, mime_type, file_size_bytes,
          reference_image_urls_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.artifactId,
        input.eventId,
        input.prompt,
        input.modelId,
        input.modelName,
        input.aspectRatio ?? null,
        input.seed ?? null,
        input.negativePrompt ?? null,
        JSON.stringify(input.providerOptions),
        input.sourceUrl ?? null,
        input.filePath,
        input.fileName,
        input.mimeType,
        input.fileSizeBytes,
        input.referenceImageUrls ? JSON.stringify(input.referenceImageUrls) : null,
        now,
        now,
      );
  }

  listImageArtifacts(input: ListImageArtifactsInput = {}): ImageArtifactRow[] {
    const limit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 50)));
    const rows = this.database
      .prepare(
        `SELECT artifact_id, event_id, prompt, model_id, model_name, aspect_ratio, seed, negative_prompt,
                provider_options_json, source_url, file_path, file_name, mime_type, file_size_bytes,
                reference_image_urls_json, created_at, updated_at
         FROM image_artifacts
         WHERE (?1 IS NULL OR event_id = ?1)
           AND (?2 IS NULL OR created_at > ?2)
         ORDER BY created_at DESC
         LIMIT ?3`
      )
      .all(input.eventId ?? null, input.after ?? null, limit) as unknown as Array<ImageArtifactRow>;
    return rows;
  }

  recordSessionMemoryChunk(input: RecordSessionMemoryChunkInput): void {
    this.database
      .prepare(
        `INSERT OR REPLACE INTO session_memory_chunks
         (chunk_key, source_storage_key, harness_name, session_name, entry_id, kind, role, actor_id, conversation_id, thread_id, title, content, token_estimate, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.storageKey,
        input.storageKey,
        input.harnessName,
        input.sessionName,
        input.entryId,
        input.kind,
        input.role ?? null,
        input.actorId ?? null,
        input.conversationId ?? null,
        input.threadId ?? null,
        input.title,
        input.content,
        input.tokenEstimate,
        JSON.stringify(input.metadata),
        input.createdAt,
        input.updatedAt,
      );
    this.database
      .prepare(`INSERT OR REPLACE INTO session_memory_fts (chunk_key, title, content) VALUES (?, ?, ?)`)
      .run(input.storageKey, input.title, input.content);
  }

  deleteNormalizedMessageEvent(eventId: string): void {
    this.database.prepare(`DELETE FROM normalized_message_events WHERE event_id = ?`).run(eventId);
  }

  getActiveSession(input: ActiveSessionLookup): string | null {
    const row = this.database
      .prepare(
        `SELECT session_id
         FROM active_sessions
         WHERE active_key = ?`,
      )
      .get(activeSessionKey(input)) as ActiveSessionRow | undefined;

    return typeof row?.session_id === 'string' ? row.session_id : null;
  }

  setActiveSession(input: ActiveSessionLookup & { sessionId: string }): void {
    this.database
      .prepare(
        `INSERT OR REPLACE INTO active_sessions
         (active_key, surface, connector, actor_id, conversation_id, thread_id, session_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        activeSessionKey(input),
        input.surface,
        input.connector,
        input.actorId ?? null,
        input.conversationId ?? null,
        input.threadId ?? null,
        input.sessionId,
        new Date().toISOString(),
      );
  }

  addTelegramAllowedUser(input: { userId: string; chatId: string }): void {
    this.database
      .prepare(
        `INSERT OR REPLACE INTO telegram_allowed_users (user_id, chat_id, added_at)
         VALUES (?, ?, ?)`,
      )
      .run(input.userId, input.chatId, new Date().toISOString());
  }

  removeTelegramAllowedUser(userId: string): void {
    this.database.prepare(`DELETE FROM telegram_allowed_users WHERE user_id = ?`).run(userId);
  }

  isTelegramUserAllowed(userId: string): boolean {
    const row = this.database
      .prepare(`SELECT 1 FROM telegram_allowed_users WHERE user_id = ?`)
      .get(userId) as { '1': number } | undefined;
    return row != null;
  }

  listTelegramAllowedUsers(): { userId: string; chatId: string; addedAt: string }[] {
    const rows = this.database
      .prepare(`SELECT user_id, chat_id, added_at FROM telegram_allowed_users ORDER BY added_at DESC`)
      .all() as unknown as TelegramAllowedUserRow[];
    return rows.map((row) => ({
      userId: row.user_id,
      chatId: row.chat_id,
      addedAt: row.added_at,
    }));
  }

  createTelegramPendingPairing(input: {
    code: string;
    senderId: string;
    chatId: string;
    expiresAt: string;
  }): void {
    this.database
      .prepare(
        `INSERT INTO telegram_pending_pairings (code, sender_id, chat_id, created_at, expires_at, replies)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(code) DO UPDATE SET
           sender_id = excluded.sender_id,
           chat_id = excluded.chat_id,
           created_at = excluded.created_at,
           expires_at = excluded.expires_at,
           replies = excluded.replies`,
      )
      .run(input.code, input.senderId, input.chatId, new Date().toISOString(), input.expiresAt, 1);
  }

  incrementTelegramPendingPairingReplies(code: string): number {
    const result = this.database
      .prepare(
        `UPDATE telegram_pending_pairings
         SET replies = replies + 1
         WHERE code = ?`,
      )
      .run(code);
    if (result.changes === 0) return 0;
    const updated = this.getTelegramPendingPairing(code);
    return updated?.replies ?? 0;
  }

  getTelegramPendingPairing(code: string): {
    code: string;
    senderId: string;
    chatId: string;
    createdAt: string;
    expiresAt: string;
    replies: number;
  } | null {
    const row = this.database
      .prepare(`SELECT code, sender_id, chat_id, created_at, expires_at, replies
                 FROM telegram_pending_pairings WHERE code = ?`)
      .get(code) as TelegramPendingPairingRow | undefined;
    if (!row) return null;
    return {
      code: row.code,
      senderId: row.sender_id,
      chatId: row.chat_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      replies: row.replies,
    };
  }

  approveTelegramPendingPairing(code: string): { userId: string; chatId: string } | null {
    this.pruneExpiredTelegramPendingPairings();
    const pending = this.getTelegramPendingPairing(code);
    if (!pending) return null;
    if (pending.expiresAt < new Date().toISOString()) {
      this.database.prepare(`DELETE FROM telegram_pending_pairings WHERE code = ?`).run(code);
      return null;
    }

    this.database
      .prepare(`DELETE FROM telegram_pending_pairings WHERE code = ?`)
      .run(code);

    this.addTelegramAllowedUser({ userId: pending.senderId, chatId: pending.chatId });
    return { userId: pending.senderId, chatId: pending.chatId };
  }

  deleteTelegramPendingPairing(code: string): boolean {
    const result = this.database
      .prepare(`DELETE FROM telegram_pending_pairings WHERE code = ?`)
      .run(code);
    return result.changes > 0;
  }

  pruneExpiredTelegramPendingPairings(): void {
    this.database
      .prepare(`DELETE FROM telegram_pending_pairings WHERE expires_at < ?`)
      .run(new Date().toISOString());
  }

  listTelegramPendingPairings(): {
    code: string;
    senderId: string;
    chatId: string;
    createdAt: string;
    expiresAt: string;
    replies: number;
  }[] {
    this.pruneExpiredTelegramPendingPairings();
    const rows = this.database
      .prepare(`SELECT code, sender_id, chat_id, created_at, expires_at, replies
                 FROM telegram_pending_pairings ORDER BY created_at DESC`)
      .all() as unknown as TelegramPendingPairingRow[];
    return rows.map((row) => ({
      code: row.code,
      senderId: row.sender_id,
      chatId: row.chat_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      replies: row.replies,
    }));
  }

  setTelegramGroup(input: {
    groupId: string;
    requireMention: boolean;
    allowFrom?: string[];
  }): void {
    this.database
      .prepare(
        `INSERT OR REPLACE INTO telegram_groups (group_id, require_mention, allow_from, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        input.groupId,
        input.requireMention ? 1 : 0,
        input.allowFrom != null ? JSON.stringify(input.allowFrom) : null,
        new Date().toISOString(),
      );
  }

  getTelegramGroup(groupId: string): {
    groupId: string;
    requireMention: boolean;
    allowFrom: string[];
  } | null {
    const row = this.database
      .prepare(`SELECT group_id, require_mention, allow_from FROM telegram_groups WHERE group_id = ?`)
      .get(groupId) as TelegramGroupRow | undefined;
    if (!row) return null;
    return {
      groupId: row.group_id,
      requireMention: Boolean(row.require_mention),
      allowFrom: parseJsonStringArray(row.allow_from),
    };
  }

  removeTelegramGroup(groupId: string): boolean {
    const result = this.database.prepare(`DELETE FROM telegram_groups WHERE group_id = ?`).run(groupId);
    return result.changes > 0;
  }

  listTelegramGroups(): {
    groupId: string;
    requireMention: boolean;
    allowFrom: string[];
  }[] {
    const rows = this.database
      .prepare(`SELECT group_id, require_mention, allow_from FROM telegram_groups ORDER BY group_id`)
      .all() as unknown as TelegramGroupRow[];
    return rows.map((row) => ({
      groupId: row.group_id,
      requireMention: Boolean(row.require_mention),
      allowFrom: parseJsonStringArray(row.allow_from),
    }));
  }

  setTelegramSetting(key: string, value: string): void {
    this.database
      .prepare(
        `INSERT OR REPLACE INTO telegram_settings (key, value, updated_at) VALUES (?, ?, ?)`,
      )
      .run(key, value, new Date().toISOString());
  }

  getTelegramSetting(key: string): string | null {
    const row = this.database
      .prepare(`SELECT value FROM telegram_settings WHERE key = ?`)
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  searchSessionMemory(input: SessionMemorySearchInput): SessionMemoryRecord[] {
    const query = createFtsQuery(input.text);
    if (!query) {
      return [];
    }
    const scope = createMemoryScope(input);
    if (!scope) {
      return [];
    }

    const rows = this.database
      .prepare(
        `SELECT c.chunk_key,
                c.source_storage_key,
                c.harness_name,
                c.session_name,
                c.entry_id,
                c.kind,
                c.role,
                c.actor_id,
                c.conversation_id,
                c.thread_id,
                c.title,
                c.content,
                c.token_estimate,
                c.metadata_json,
                c.created_at,
                c.updated_at,
                bm25(session_memory_fts) AS rank
         FROM session_memory_fts
         JOIN session_memory_chunks c ON c.chunk_key = session_memory_fts.chunk_key
         WHERE session_memory_fts MATCH ?
           AND ${scope.where}
         ORDER BY rank
         LIMIT ?`,
      )
      .all(query, ...scope.params, Math.max(1, Math.min(20, Math.floor(input.limit ?? 5)))) as unknown as SessionMemoryChunkRow[];

    return rows.map(toSessionMemoryRecord);
  }

  migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS flue_session_index (
        storage_key TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        harness_name TEXT NOT NULL,
        session_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_flue_session_index_logical
        ON flue_session_index(harness_name, session_name, updated_at);

      CREATE TABLE IF NOT EXISTS flue_logical_sessions (
        harness_name TEXT NOT NULL,
        session_name TEXT NOT NULL,
        latest_storage_key TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (harness_name, session_name)
      );

      CREATE TABLE IF NOT EXISTS flue_instance_sessions (
        instance_id TEXT NOT NULL,
        harness_name TEXT NOT NULL,
        session_name TEXT NOT NULL,
        latest_storage_key TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (instance_id, harness_name, session_name)
      );

      CREATE INDEX IF NOT EXISTS idx_flue_instance_sessions_updated
        ON flue_instance_sessions(instance_id, updated_at);

      CREATE TABLE IF NOT EXISTS chat_sessions (
        session_id TEXT PRIMARY KEY,
        origin TEXT NOT NULL,
        actor_id TEXT,
        conversation_id TEXT,
        thread_id TEXT,
        title TEXT,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated
        ON chat_sessions(updated_at DESC);

      CREATE TABLE IF NOT EXISTS active_sessions (
        active_key TEXT PRIMARY KEY,
        surface TEXT NOT NULL,
        connector TEXT NOT NULL,
        actor_id TEXT,
        conversation_id TEXT,
        thread_id TEXT,
        session_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS normalized_message_events (
        event_id TEXT PRIMARY KEY,
        session_id TEXT,
        connector TEXT NOT NULL,
        message_kind TEXT NOT NULL,
        text TEXT NOT NULL,
        received_at TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        actor_display_name TEXT,
        conversation_id TEXT NOT NULL,
        thread_id TEXT,
        client_id TEXT,
        project_id TEXT,
        workflow TEXT,
        task TEXT,
        delivery_kind TEXT,
        delivery_id TEXT,
        accepted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_normalized_message_events_session
        ON normalized_message_events(session_id, received_at);

      CREATE TABLE IF NOT EXISTS session_memory_chunks (
        chunk_key TEXT PRIMARY KEY,
        source_storage_key TEXT NOT NULL,
        harness_name TEXT NOT NULL,
        session_name TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        role TEXT,
        actor_id TEXT,
        conversation_id TEXT,
        thread_id TEXT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        token_estimate INTEGER NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_session_memory_session
        ON session_memory_chunks(harness_name, session_name);

      CREATE VIRTUAL TABLE IF NOT EXISTS session_memory_fts
        USING fts5(chunk_key UNINDEXED, title, content);

      CREATE TABLE IF NOT EXISTS telegram_allowed_users (
        user_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        added_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS telegram_pending_pairings (
        code TEXT PRIMARY KEY,
        sender_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        replies INTEGER NOT NULL DEFAULT 1
      );

      CREATE INDEX IF NOT EXISTS idx_telegram_pending_expires
        ON telegram_pending_pairings(expires_at);

      CREATE TABLE IF NOT EXISTS telegram_groups (
        group_id TEXT PRIMARY KEY,
        require_mention INTEGER NOT NULL DEFAULT 1,
        allow_from TEXT,
        updated_at TEXT NOT NULL
      );


      CREATE TABLE IF NOT EXISTS image_artifacts (
        artifact_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        model_id TEXT NOT NULL,
        model_name TEXT NOT NULL,
        aspect_ratio TEXT,
        seed INTEGER,
        negative_prompt TEXT,
        provider_options_json TEXT NOT NULL,
        source_url TEXT,
        file_path TEXT NOT NULL,
        file_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        file_size_bytes INTEGER NOT NULL,
        reference_image_urls_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_image_artifacts_event
        ON image_artifacts(event_id);

      CREATE INDEX IF NOT EXISTS idx_image_artifacts_created
        ON image_artifacts(created_at DESC);

      CREATE TABLE IF NOT EXISTS telegram_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    this.ensureSessionMemoryScopeColumns();
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS idx_session_memory_scope
        ON session_memory_chunks(actor_id, conversation_id, session_name);
    `);
  }

  private ensureSessionMemoryScopeColumns(): void {
    const existingColumns = new Set(
      (this.database.prepare(`PRAGMA table_info(session_memory_chunks)`).all() as unknown as Array<{ name: string }>)
        .map((column) => column.name),
    );

    for (const [column, definition] of [
      ['actor_id', 'TEXT'],
      ['conversation_id', 'TEXT'],
      ['thread_id', 'TEXT'],
    ] as const) {
      if (!existingColumns.has(column)) {
        try {
          this.database.exec(`ALTER TABLE session_memory_chunks ADD COLUMN ${column} ${definition}`);
        } catch (error) {
          if (!String(error).includes('duplicate column name')) {
            throw error;
          }
        }
      }
    }
  }

  private async indexSessionMemory(
    storageKey: string,
    harnessName: string,
    sessionName: string,
    data: SessionData,
  ): Promise<void> {
    this.deleteSessionMemoryByStorageKey(storageKey);
    const parts = parseFlueSessionStorageKey(storageKey);
    const chatSession =
      this.getChatSession(sessionName) ??
      (parts && this.isDirectAgentChatSession(parts.instanceId, harnessName, sessionName)
        ? this.getChatSession(parts.instanceId)
        : null);

    for (const chunk of extractSessionMemoryChunks({
      storageKey,
      harnessName,
      sessionName,
      actorId: chatSession?.actorId,
      conversationId: chatSession?.conversationId,
      threadId: chatSession?.threadId,
      data,
    })) {
      this.database
        .prepare(
          `INSERT OR REPLACE INTO session_memory_chunks
           (chunk_key, source_storage_key, harness_name, session_name, entry_id, kind, role, actor_id, conversation_id, thread_id, title, content, token_estimate, metadata_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          chunk.id,
          storageKey,
          harnessName,
          sessionName,
          chunk.entryId,
          chunk.kind,
          chunk.role ?? null,
          chunk.actorId ?? null,
          chunk.conversationId ?? null,
          chunk.threadId ?? null,
          chunk.title,
          chunk.content,
          chunk.tokenEstimate,
          JSON.stringify(chunk.metadata),
          chunk.createdAt,
          chunk.updatedAt,
        );
      this.database
        .prepare(`INSERT OR REPLACE INTO session_memory_fts (chunk_key, title, content) VALUES (?, ?, ?)`)
        .run(chunk.id, chunk.title, chunk.content);
    }

    const chunks = extractSessionMemoryChunks({
      storageKey,
      harnessName,
      sessionName,
      actorId: chatSession?.actorId,
      conversationId: chatSession?.conversationId,
      threadId: chatSession?.threadId,
      data,
    });
    await this.indexSessionMemoryVectors(storageKey, harnessName, sessionName, chunks);
  }

  private buildSessionMemoryVectorRecord(
    chunk: ExtractedSessionMemoryChunk,
    vector: number[],
    storageKey: string,
    harnessName: string,
    sessionName: string,
    embeddingError?: string,
  ): VectorRecord {
    return {
      id: chunk.id,
      chunk_key: chunk.id,
      source: 'session_memory',
      title: chunk.title,
      content: chunk.content,
      vector,
      actor_id: chunk.actorId,
      conversation_id: chunk.conversationId,
      session_name: sessionName,
      thread_id: chunk.threadId,
      metadata: {
        ...chunk.metadata,
        storageKey,
        harnessName,
        sessionName,
        entryId: chunk.entryId,
        kind: chunk.kind,
        role: chunk.role,
        ...(embeddingError ? { embeddingError } : {}),
      },
      updated_at: chunk.updatedAt,
    };
  }

  private async indexSessionMemoryVectors(
    storageKey: string,
    harnessName: string,
    sessionName: string,
    chunks: ExtractedSessionMemoryChunk[],
  ): Promise<void> {
    if (!this.vectorStore || !this.embeddingClient || chunks.length === 0) {
      return;
    }

    try {
      const contents = chunks.map((chunk) => chunk.content);
      const vectors = await this.embeddingClient.embedBatch(contents);

      if (vectors.length !== chunks.length) {
        throw new Error(
          `Embedding provider returned ${vectors.length} vectors for ${chunks.length} chunks`,
        );
      }

      const records = chunks.map((chunk, index): VectorRecord =>
        this.buildSessionMemoryVectorRecord(
          chunk,
          vectors[index],
          storageKey,
          harnessName,
          sessionName,
        ),
      );

      await this.vectorStore.upsert('session_memory', records);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[WARN] Failed to index session memory vectors for ${storageKey}; falling back to zero-vector keyword records:`,
        message,
      );

      try {
        const dimensions = await getOnnxEmbeddingDimensions();
        const fallbackRecords = chunks.map((chunk): VectorRecord =>
          this.buildSessionMemoryVectorRecord(
            chunk,
            new Array(dimensions).fill(0),
            storageKey,
            harnessName,
            sessionName,
            message,
          ),
        );
        await this.vectorStore.upsert('session_memory', fallbackRecords);
      } catch (fallbackError) {
        console.error(
          `[WARN] Failed to write session memory vector fallback for ${storageKey}:`,
          fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
        );
      }
    }
  }

  private deleteSessionMemoryByStorageKey(storageKey: string): void {
    const rows = this.database
      .prepare(`SELECT chunk_key FROM session_memory_chunks WHERE source_storage_key = ?`)
      .all(storageKey) as unknown as Array<{ chunk_key: string }>;

    const chunkKeys = rows.map((row) => row.chunk_key);
    for (const chunkKey of chunkKeys) {
      this.database.prepare(`DELETE FROM session_memory_fts WHERE chunk_key = ?`).run(chunkKey);
    }
    this.database.prepare(`DELETE FROM session_memory_chunks WHERE source_storage_key = ?`).run(storageKey);

    this.deleteSessionMemoryVectors(storageKey, chunkKeys);
  }

  private deleteSessionMemoryVectors(storageKey: string, chunkKeys: string[]): void {
    if (!this.vectorStore || chunkKeys.length === 0) {
      return;
    }

    this.enqueueStorageOp(storageKey, () => this.vectorStore!.delete('session_memory', chunkKeys));
  }

  private enqueueStorageOp(storageKey: string, operation: () => Promise<unknown>): void {
    const currentPromise = this.pendingStorageOps.get(storageKey) ?? Promise.resolve();
    const nextPromise = currentPromise.then(operation).catch((error) => {
      console.error(
        '[WARN] Session storage operation failed:',
        error instanceof Error ? error.message : String(error),
      );
    });
    this.pendingStorageOps.set(storageKey, nextPromise);
  }

  private async deleteSessionMemoryVectorsFinished(storageKey: string): Promise<void> {
    await this.awaitPendingStorageOps(storageKey);
  }

  async awaitPendingVectorDeletes(): Promise<void> {
    await Promise.all(this.pendingStorageOps.values());
  }

  async awaitPendingVectorDeletesForSession(storageKey: string): Promise<void> {
    await this.awaitPendingStorageOps(storageKey);
  }

  private async awaitPendingStorageOps(storageKey: string): Promise<void> {
    const promise = this.pendingStorageOps.get(storageKey);
    if (promise) {
      await promise;
      if (this.pendingStorageOps.get(storageKey) === promise) {
        this.pendingStorageOps.delete(storageKey);
      }
    }
  }

  enqueueSessionMemoryUpsert(storageKey: string, operation: () => Promise<unknown>): void {
    this.enqueueStorageOp(storageKey, operation);
  }

  private deleteInstanceSessionIndex(
    instanceId: string,
    harnessName: string,
    sessionName: string,
    deletedStorageKey: string,
  ): void {
    const latest = this.getLatestStorageKeyForInstance(instanceId, harnessName, sessionName);
    if (latest !== deletedStorageKey) {
      return;
    }

    const replacement = this.getMostRecentIndexedStorageKeyForInstance(instanceId, harnessName, sessionName);
    if (replacement) {
      this.database
        .prepare(
          `UPDATE flue_instance_sessions
           SET latest_storage_key = ?, updated_at = ?
           WHERE instance_id = ? AND harness_name = ? AND session_name = ?`,
        )
        .run(replacement.storageKey, replacement.updatedAt, instanceId, harnessName, sessionName);
      return;
    }

    this.database
      .prepare(
        `DELETE FROM flue_instance_sessions
         WHERE instance_id = ? AND harness_name = ? AND session_name = ?`,
      )
      .run(instanceId, harnessName, sessionName);
  }

  private getMostRecentIndexedStorageKeyForInstance(
    instanceId: string,
    harnessName: string,
    sessionName: string,
  ): {
    storageKey: string;
    updatedAt: string;
  } | null {
    const row = this.database
      .prepare(
        `SELECT storage_key, updated_at
         FROM flue_session_index
         WHERE instance_id = ? AND harness_name = ? AND session_name = ?
         ORDER BY updated_at DESC, created_at DESC, storage_key DESC
         LIMIT 1`,
      )
      .get(instanceId, harnessName, sessionName) as IndexedSessionRow | undefined;

    return row ? { storageKey: row.storage_key, updatedAt: row.updated_at } : null;
  }

  private isDirectAgentChatSession(instanceId: string, harnessName: string, sessionName: string): boolean {
    return (
      harnessName === directAgentHarnessName &&
      sessionName === directAgentSessionName &&
      this.getChatSession(instanceId) !== null
    );
  }
}

function resolveRuntimePath(filePath: string): string {
  return isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);
}

function createSessionId(origin: string): string {
  const prefix = String(origin).replace(/[^a-z0-9-]+/gi, '-').toLowerCase() || 'session';
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
}

interface ExtractSessionMemoryInput {
  storageKey: string;
  harnessName: string;
  sessionName: string;
  actorId?: string;
  conversationId?: string;
  threadId?: string;
  data: SessionData;
}

interface ExtractedSessionMemoryChunk {
  id: string;
  entryId: string;
  kind: string;
  role?: string;
  actorId?: string;
  conversationId?: string;
  threadId?: string;
  title: string;
  content: string;
  tokenEstimate: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

function extractSessionMemoryChunks(input: ExtractSessionMemoryInput): ExtractedSessionMemoryChunk[] {
  const chunks: ExtractedSessionMemoryChunk[] = [];

  for (const entry of input.data.entries) {
    if (entry.type === 'message') {
      const role = String(entry.message.role ?? 'message');
      const content = extractMessageText(entry.message);
      if (!content.trim()) {
        continue;
      }

      chunks.push({
        id: createChunkKey(input, entry.id, 'message'),
        entryId: entry.id,
        kind: 'message',
        role,
        title: `${role} message in ${input.sessionName}`,
        content,
        tokenEstimate: estimateTextTokens(content),
        actorId: input.actorId,
        conversationId: input.conversationId,
        threadId: input.threadId,
        metadata: {
          source: 'flue-session',
          sessionName: input.sessionName,
          actorId: input.actorId,
          conversationId: input.conversationId,
          threadId: input.threadId,
          role,
        },
        createdAt: entry.timestamp,
        updatedAt: input.data.updatedAt,
      });
      continue;
    }

    if (entry.type === 'compaction') {
      chunks.push({
        id: createChunkKey(input, entry.id, 'compaction'),
        entryId: entry.id,
        kind: 'compaction',
        title: `compaction summary in ${input.sessionName}`,
        content: entry.summary,
        tokenEstimate: estimateTextTokens(entry.summary),
        actorId: input.actorId,
        conversationId: input.conversationId,
        threadId: input.threadId,
        metadata: {
          source: 'flue-session',
          sessionName: input.sessionName,
          actorId: input.actorId,
          conversationId: input.conversationId,
          threadId: input.threadId,
        },
        createdAt: entry.timestamp,
        updatedAt: input.data.updatedAt,
      });
      continue;
    }

    // 'branch_summary' is not a native Flue 1.0 beta SessionEntry type. Historical entries
    // of this kind are dropped from vector indexing. They remain in raw session storage.
  }

  return chunks;
}

function extractMessageText(message: unknown): string {
  const content =
    message && typeof message === 'object' && 'content' in message
      ? (message as { content?: unknown }).content
      : undefined;
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (!block || typeof block !== 'object') {
          return '';
        }
        const candidate = block as {
          text?: unknown;
          thinking?: unknown;
          name?: unknown;
          arguments?: unknown;
        };
        if (typeof candidate.text === 'string') {
          return candidate.text;
        }
        if (typeof candidate.name === 'string') {
          return `${candidate.name} ${JSON.stringify(candidate.arguments ?? {})}`;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n\n');
  }

  return JSON.stringify(content ?? '');
}

function createChunkKey(input: ExtractSessionMemoryInput, entryId: string, kind: string): string {
  return createHash('sha256')
    .update(JSON.stringify([input.storageKey, input.harnessName, input.sessionName, entryId, kind]))
    .digest('hex');
}

function createFtsQuery(text: string): string {
  const terms = text
    .toLowerCase()
    .match(/[a-z0-9_'-]{2,}/g)
    ?.slice(0, 12);
  return terms?.map((term) => `"${term.replace(/"/g, '""')}"`).join(' OR ') ?? '';
}

function createMemoryScope(input: SessionMemorySearchInput): {
  where: string;
  params: string[];
} | undefined {
  const sessionId = cleanScopeValue(input.sessionId);
  const actorId = cleanScopeValue(input.actorId);
  const conversationId = cleanScopeValue(input.conversationId);
  const where: string[] = [];
  const params: string[] = [];

  if (sessionId) {
    where.push('c.session_name = ?');
    params.push(sessionId);
  }

  const accessWhere: string[] = [];
  if (actorId) {
    accessWhere.push('c.actor_id = ?');
    params.push(actorId);
  }
  if (conversationId) {
    accessWhere.push('c.conversation_id = ?');
    params.push(conversationId);
  }

  if (accessWhere.length) {
    where.push(`(${accessWhere.join(' OR ')})`);
  }

  return where.length ? { where: where.join(' AND '), params } : undefined;
}

function cleanScopeValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function activeSessionKey(input: ActiveSessionLookup): string {
  return [
    input.surface,
    input.connector,
    input.actorId ?? '',
    input.conversationId ?? '',
    input.threadId ?? '',
  ].join('\u0000');
}

function toChatSessionRecord(row: ChatSessionRow): ChatSessionRecord {
  return {
    sessionId: row.session_id,
    origin: row.origin,
    ...(typeof row.actor_id === 'string' ? { actorId: row.actor_id } : {}),
    ...(typeof row.conversation_id === 'string' ? { conversationId: row.conversation_id } : {}),
    ...(typeof row.thread_id === 'string' ? { threadId: row.thread_id } : {}),
    ...(typeof row.title === 'string' ? { title: row.title } : {}),
    ...(typeof row.archived_at === 'string' ? { archivedAt: row.archived_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toNormalizedMessageEvent(row: NormalizedMessageEventRow): NormalizedMessageEvent {
  const context = {
    ...(typeof row.client_id === 'string' ? { clientId: row.client_id } : {}),
    ...(typeof row.project_id === 'string' ? { projectId: row.project_id } : {}),
    ...(typeof row.workflow === 'string' ? { workflow: row.workflow } : {}),
    ...(typeof row.task === 'string' ? { task: row.task } : {}),
  };

  return {
    id: row.event_id,
    connector: row.connector as NormalizedMessageEvent['connector'],
    kind: row.message_kind as NormalizedMessageEvent['kind'],
    text: row.text,
    receivedAt: row.received_at,
    actor: {
      id: row.actor_id,
      ...(typeof row.actor_display_name === 'string' ? { displayName: row.actor_display_name } : {}),
    },
    conversation: {
      id: row.conversation_id,
      ...(typeof row.thread_id === 'string' ? { threadId: row.thread_id } : {}),
    },
    ...(Object.keys(context).length ? { context } : {}),
    ...(typeof row.delivery_kind === 'string' ? { deliveryKind: row.delivery_kind } : {}),
    ...(typeof row.delivery_id === 'string' ? { deliveryId: row.delivery_id } : {}),
    ...(typeof row.accepted_at === 'string' ? { acceptedAt: row.accepted_at } : {}),
  };
}

function toSessionMemoryRecord(row: SessionMemoryChunkRow): SessionMemoryRecord {
  const rank = typeof row.rank === 'number' ? row.rank : 0;
  return {
    id: row.chunk_key,
    storageKey: row.source_storage_key,
    harnessName: row.harness_name,
    sessionName: row.session_name,
    entryId: row.entry_id,
    kind: row.kind,
    ...(typeof row.role === 'string' ? { role: row.role } : {}),
    ...(typeof row.actor_id === 'string' ? { actorId: row.actor_id } : {}),
    ...(typeof row.conversation_id === 'string' ? { conversationId: row.conversation_id } : {}),
    ...(typeof row.thread_id === 'string' ? { threadId: row.thread_id } : {}),
    title: row.title,
    content: row.content,
    score: 1 / (1 + Math.abs(rank)),
    tokenEstimate: Number(row.token_estimate),
    metadata: parseMetadata(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseMetadata(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

interface LatestSessionRow {
  latest_storage_key: string;
}

interface IndexedSessionRow {
  storage_key: string;
  updated_at: string;
}

interface ChatSessionRow {
  session_id: string;
  origin: string;
  actor_id: string | null;
  conversation_id: string | null;
  thread_id: string | null;
  title: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ActiveSessionRow {
  session_id: string;
}


interface ImageArtifactRow {
  artifact_id: string;
  event_id: string;
  prompt: string;
  model_id: string;
  model_name: string;
  aspect_ratio: string | null;
  seed: number | null;
  negative_prompt: string | null;
  provider_options_json: string;
  source_url: string | null;
  file_path: string;
  file_name: string;
  mime_type: string;
  file_size_bytes: number;
  reference_image_urls_json: string | null;
  created_at: string;
  updated_at: string;
}

interface NormalizedMessageEventRow {
  event_id: string;
  connector: string;
  message_kind: string;
  text: string;
  received_at: string;
  actor_id: string;
  actor_display_name: string | null;
  conversation_id: string;
  thread_id: string | null;
  client_id: string | null;
  project_id: string | null;
  workflow: string | null;
  task: string | null;
  delivery_kind: string | null;
  delivery_id: string | null;
  accepted_at: string | null;
}

interface SessionMemoryChunkRow {
  chunk_key: string;
  source_storage_key: string;
  harness_name: string;
  session_name: string;
  entry_id: string;
  kind: string;
  role: string | null;
  actor_id: string | null;
  conversation_id: string | null;
  thread_id: string | null;
  title: string;
  content: string;
  token_estimate: number;
  metadata_json: string;
  created_at: string;
  updated_at: string;
  rank: number;
}

interface TelegramAllowedUserRow {
  user_id: string;
  chat_id: string;
  added_at: string;
}

interface TelegramPendingPairingRow {
  code: string;
  sender_id: string;
  chat_id: string;
  created_at: string;
  expires_at: string;
  replies: number;
}

interface TelegramGroupRow {
  group_id: string;
  require_mention: number;
  allow_from: string | null;
}

function parseJsonStringArray(value: string | null | undefined): string[] {
  if (typeof value !== 'string' || !value.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === 'string');
    }
  } catch {
    // fall through
  }
  return [];
}







