import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SessionData } from '@flue/runtime/adapter';
import { estimateTextTokens } from './context-budget.js';
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
}

export interface SessionMemoryRecord {
  id: string;
  storageKey: string;
  harnessName: string;
  sessionName: string;
  entryId: string;
  kind: string;
  role?: string;
  title: string;
  content: string;
  score: number;
  tokenEstimate: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export class GoromboSessionDatabase {
  private readonly database: DatabaseSync;

  constructor(readonly filePath = defaultSessionDatabasePath) {
    const resolved = resolveRuntimePath(filePath);
    mkdirSync(dirname(resolved), { recursive: true });
    this.database = new DatabaseSync(resolved, { timeout: 5_000 });
    this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
    this.migrate();
  }

  close(): void {
    this.database.close();
  }

  recordFlueSession(storageKey: string, data: SessionData): void {
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
        `INSERT INTO flue_logical_sessions
         (harness_name, session_name, latest_storage_key, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(harness_name, session_name) DO UPDATE SET
           latest_storage_key = excluded.latest_storage_key,
           updated_at = excluded.updated_at
         WHERE excluded.updated_at >= flue_logical_sessions.updated_at`,
      )
      .run(parts.harnessName, parts.sessionName, storageKey, updatedAt);

    this.indexSessionMemory(storageKey, parts.harnessName, parts.sessionName, data);
  }

  deleteFlueSession(storageKey: string): void {
    const parts = parseFlueSessionStorageKey(storageKey);
    if (!parts) {
      return;
    }

    this.database.prepare(`DELETE FROM flue_session_index WHERE storage_key = ?`).run(storageKey);
    this.deleteSessionMemoryByStorageKey(storageKey);

    const latest = this.getLatestStorageKey(parts.harnessName, parts.sessionName);
    if (latest === storageKey) {
      this.database
        .prepare(`DELETE FROM flue_logical_sessions WHERE harness_name = ? AND session_name = ?`)
        .run(parts.harnessName, parts.sessionName);
    }
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

  searchSessionMemory(input: SessionMemorySearchInput): SessionMemoryRecord[] {
    const query = createFtsQuery(input.text);
    if (!query) {
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
         ORDER BY rank
         LIMIT ?`,
      )
      .all(query, Math.max(1, Math.min(20, Math.floor(input.limit ?? 5)))) as unknown as SessionMemoryChunkRow[];

    return rows.map(toSessionMemoryRecord);
  }

  private migrate(): void {
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

      CREATE TABLE IF NOT EXISTS session_memory_chunks (
        chunk_key TEXT PRIMARY KEY,
        source_storage_key TEXT NOT NULL,
        harness_name TEXT NOT NULL,
        session_name TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        role TEXT,
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
    `);
  }

  private indexSessionMemory(
    storageKey: string,
    harnessName: string,
    sessionName: string,
    data: SessionData,
  ): void {
    this.deleteSessionMemoryByStorageKey(storageKey);

    for (const chunk of extractSessionMemoryChunks({ storageKey, harnessName, sessionName, data })) {
      this.database
        .prepare(
          `INSERT OR REPLACE INTO session_memory_chunks
           (chunk_key, source_storage_key, harness_name, session_name, entry_id, kind, role, title, content, token_estimate, metadata_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          chunk.id,
          storageKey,
          harnessName,
          sessionName,
          chunk.entryId,
          chunk.kind,
          chunk.role ?? null,
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
  }

  private deleteSessionMemoryByStorageKey(storageKey: string): void {
    const rows = this.database
      .prepare(`SELECT chunk_key FROM session_memory_chunks WHERE source_storage_key = ?`)
      .all(storageKey) as unknown as Array<{ chunk_key: string }>;

    for (const row of rows) {
      this.database.prepare(`DELETE FROM session_memory_fts WHERE chunk_key = ?`).run(row.chunk_key);
    }
    this.database.prepare(`DELETE FROM session_memory_chunks WHERE source_storage_key = ?`).run(storageKey);
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
  data: SessionData;
}

interface ExtractedSessionMemoryChunk {
  id: string;
  entryId: string;
  kind: string;
  role?: string;
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
        metadata: {
          source: 'flue-session',
          sessionName: input.sessionName,
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
        metadata: {
          source: 'flue-session',
          sessionName: input.sessionName,
        },
        createdAt: entry.timestamp,
        updatedAt: input.data.updatedAt,
      });
      continue;
    }

    if (entry.type === 'branch_summary') {
      chunks.push({
        id: createChunkKey(input, entry.id, 'branch_summary'),
        entryId: entry.id,
        kind: 'branch_summary',
        title: `branch summary in ${input.sessionName}`,
        content: entry.summary,
        tokenEstimate: estimateTextTokens(entry.summary),
        metadata: {
          source: 'flue-session',
          sessionName: input.sessionName,
        },
        createdAt: entry.timestamp,
        updatedAt: input.data.updatedAt,
      });
    }
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
        if (typeof candidate.thinking === 'string') {
          return candidate.thinking;
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

interface SessionMemoryChunkRow {
  chunk_key: string;
  source_storage_key: string;
  harness_name: string;
  session_name: string;
  entry_id: string;
  kind: string;
  role: string | null;
  title: string;
  content: string;
  token_estimate: number;
  metadata_json: string;
  created_at: string;
  updated_at: string;
  rank: number;
}
