import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { parse as vParse } from 'valibot';
import type {
  Checklist,
  MemoryRecord,
  MemoryRecordScope,
  SessionNote,
  Todo,
} from '../../core/types/memory.js';
import { MemoryRecordSchema } from '../../core/types/memory.js';

export const defaultStructuredMemoryDatabasePath = '.gorombo/db/structured-memory.sqlite';

export interface StructuredMemoryAudit {
  updatedBy: string;
  runId?: string;
}

export interface GoromboStructuredMemoryDatabaseOptions {
  filePath?: string;
}

/**
 * Durable storage for structured-memory records (checklists, todos, session
 * notes). TS owns the schema: the full record is stored as JSON in
 * `record_json`, with scope denormalized into indexed columns for cold-start
 * hydration. The Rust WASM engine owns query/indexing; the database is the
 * source of truth across process restarts and feeds `reconcile_index` on cold
 * start.
 *
 * A single table is used (rather than one per kind) because the engine — not
 * SQL — performs queries against the in-memory index. The full record JSON is
 * the authoritative payload; the denormalized columns exist only to make
 * cold-start hydration and the cleanup job cheap.
 */
export class GoromboStructuredMemoryDatabase {
  private readonly database: DatabaseSync;

  constructor(options: GoromboStructuredMemoryDatabaseOptions = {}) {
    const resolved = resolveRuntimePath(options.filePath ?? defaultStructuredMemoryDatabasePath);
    mkdirSync(dirname(resolved), { recursive: true });
    this.database = new DatabaseSync(resolved, { timeout: 5_000 });
    this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
    this.migrate();
  }

  close(): void {
    this.database.close();
  }

  migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS structured_memory_records (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        slug TEXT,
        scope_json TEXT NOT NULL,
        actor_id TEXT,
        conversation_id TEXT,
        project_id TEXT,
        thread_id TEXT,
        global INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_structured_memory_project
        ON structured_memory_records(project_id);

      CREATE INDEX IF NOT EXISTS idx_structured_memory_conversation
        ON structured_memory_records(conversation_id);

      CREATE INDEX IF NOT EXISTS idx_structured_memory_actor
        ON structured_memory_records(actor_id);

      CREATE INDEX IF NOT EXISTS idx_structured_memory_kind
        ON structured_memory_records(kind);

      CREATE INDEX IF NOT EXISTS idx_structured_memory_updated
        ON structured_memory_records(updated_at);
    `);
  }

  writeRecord(record: MemoryRecord): void {
    const scope = record.scope;
    const scopeJson = JSON.stringify(scope);
    const denorm = denormalizeScope(scope);
    this.database
      .prepare(
        `INSERT OR REPLACE INTO structured_memory_records
         (id, kind, title, slug, scope_json, actor_id, conversation_id, project_id, thread_id,
          global, status, tags_json, updated_at, created_at, record_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.kind,
        record.title,
        slugOf(record),
        scopeJson,
        denorm.actorId ?? null,
        denorm.conversationId ?? null,
        denorm.projectId ?? null,
        denorm.threadId ?? null,
        denorm.global ? 1 : 0,
        statusOf(record),
        JSON.stringify(record.tags),
        record.updatedAt,
        createdAtOf(record),
        JSON.stringify(record),
      );
  }

  deleteRecord(id: string): void {
    this.database.prepare(`DELETE FROM structured_memory_records WHERE id = ?`).run(id);
  }

  getRecordById(id: string): MemoryRecord | null {
    const row = this.database
      .prepare(`SELECT record_json FROM structured_memory_records WHERE id = ?`)
      .get(id) as { record_json?: string } | undefined;
    if (!row?.record_json) {
      return null;
    }
    return parseRecord(row.record_json);
  }

  loadAllRecords(): MemoryRecord[] {
    const rows = this.database
      .prepare(`SELECT record_json FROM structured_memory_records ORDER BY updated_at ASC`)
      .all() as Array<{ record_json: string }>;
    return rows.map((row) => parseRecord(row.record_json)).filter((r): r is MemoryRecord => r !== null);
  }

  /**
   * Soft-archive completed todos older than `retentionDays` (sets `archivedAt`
   * so default retrieval excludes them, per plan Decision 3) and hard-delete
   * records with `archivedAt` older than `archiveDeleteDays`. Called on cold
   * start. Either bound set to 0 disables that step. Returns counts.
   */
  cleanupExpired(retentionDays: number, archiveDeleteDays: number): {
    archivedTodos: number;
    hardDeleted: number;
  } {
    const now = Date.now();
    const stamp = new Date(now).toISOString();
    let archivedTodos = 0;
    if (retentionDays > 0) {
      const cutoff = new Date(now - retentionDays * 86_400_000).toISOString();
      archivedTodos = Number(
        this.database
          .prepare(
            `UPDATE structured_memory_records
               SET record_json = json_set(record_json, '$.archivedAt', ?, '$.updatedAt', ?),
                   updated_at = ?
             WHERE kind = 'todo'
               AND status = 'completed'
               AND json_extract(record_json, '$.archivedAt') IS NULL
               AND updated_at < ?`,
          )
          .run(stamp, stamp, stamp, cutoff).changes,
      );
    }

    let hardDeleted = 0;
    if (archiveDeleteDays > 0) {
      const cutoff = new Date(now - archiveDeleteDays * 86_400_000).toISOString();
      hardDeleted = Number(
        this.database
          .prepare(
            `DELETE FROM structured_memory_records
              WHERE json_extract(record_json, '$.archivedAt') IS NOT NULL
                AND json_extract(record_json, '$.archivedAt') < ?`,
          )
          .run(cutoff).changes,
      );
    }

    return { archivedTodos, hardDeleted };
  }
}

function denormalizeScope(scope: MemoryRecordScope): {
  actorId?: string;
  conversationId?: string;
  projectId?: string;
  threadId?: string;
  global: boolean;
} {
  return {
    actorId: scope.actorId,
    conversationId: scope.conversationId,
    projectId: scope.projectId,
    threadId: scope.threadId,
    global: scope.global === true,
  };
}

function slugOf(record: MemoryRecord): string | null {
  if (record.kind === 'checklist') {
    return record.slug;
  }
  if (record.kind === 'todo') {
    return record.slug ?? null;
  }
  return null;
}

function statusOf(record: MemoryRecord): string {
  return record.status;
}

function createdAtOf(record: MemoryRecord): string {
  return record.createdAt;
}

function parseRecord(json: string): MemoryRecord | null {
  try {
    const parsed = JSON.parse(json) as unknown;
    const result = vParse(MemoryRecordSchema, parsed);
    return result;
  } catch {
    return null;
  }
}

function resolveRuntimePath(filePath: string): string {
  if (filePath.startsWith('/')) {
    return filePath;
  }
  return resolve(process.cwd(), filePath);
}

// Type guards used by callers that need kind-specific access.
export function asChecklist(record: MemoryRecord): Checklist | null {
  return record.kind === 'checklist' ? record : null;
}
export function asTodo(record: MemoryRecord): Todo | null {
  return record.kind === 'todo' ? record : null;
}
export function asSessionNote(record: MemoryRecord): SessionNote | null {
  return record.kind === 'session_note' ? record : null;
}
