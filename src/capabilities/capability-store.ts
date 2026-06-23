import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type {
  CapabilityConfig,
  CapabilityInstalledBy,
  CapabilityKind,
  CapabilityRecord,
  CapabilitySource,
  CapabilityStore,
} from './types.js';

const schemaSql = `
CREATE TABLE IF NOT EXISTS capabilities (
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('skill', 'tool', 'worker', 'mcp')),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('github', 'local', 'npm', 'builtin')),
  source_ref TEXT NOT NULL,
  version TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  config_json TEXT NOT NULL DEFAULT '{}',
  installed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  installed_by TEXT NOT NULL DEFAULT 'cli',
  PRIMARY KEY(kind, id)
);

CREATE INDEX IF NOT EXISTS idx_capabilities_kind_enabled
  ON capabilities(kind, enabled);
`;

export interface CreateCapabilityStoreOptions {
  dbPath?: string;
}

export function createCapabilityStore(options: CreateCapabilityStoreOptions = {}): CapabilityStore {
  const rawPath = options.dbPath ?? process.env.GOROMBO_CAPABILITY_DB_PATH ?? resolve(homedir(), '.gorombo', 'db', 'capabilities.sqlite');
  const dbPath = isAbsolute(rawPath) ? rawPath : resolve(process.cwd(), rawPath);

  mkdirSync(dirname(dbPath), { recursive: true });
  const database = new DatabaseSync(dbPath, { timeout: 5_000 });
  database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
  database.exec(schemaSql);

  return {
    list(options = {}) {
      let sql = 'SELECT * FROM capabilities';
      const conditions: string[] = [];
      const params: SQLInputValue[] = [];
      if (options.enabledOnly) {
        conditions.push('enabled = 1');
      }
      if (options.kind) {
        conditions.push('kind = ?');
        params.push(options.kind);
      }
      if (conditions.length > 0) {
        sql += ' WHERE ' + conditions.join(' AND ');
      }
      sql += ' ORDER BY kind ASC, id ASC';
      const rows = database.prepare(sql).all(...params);
      return rows.map(rowToCapability);
    },

    get(kind, id) {
      const row = database.prepare('SELECT * FROM capabilities WHERE kind = ? AND id = ?').get(kind, id);
      return row ? rowToCapability(row) : undefined;
    },

    insert(record) {
      database
        .prepare(
          `INSERT INTO capabilities
           (id, kind, name, description, source, source_ref, version, enabled, config_json, installed_at, updated_at, installed_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(kind, id) DO UPDATE SET
             kind = excluded.kind,
             name = excluded.name,
             description = excluded.description,
             source = excluded.source,
             source_ref = excluded.source_ref,
             version = excluded.version,
             enabled = excluded.enabled,
             config_json = excluded.config_json,
             updated_at = excluded.updated_at,
             installed_by = excluded.installed_by`,
        )
        .run(
          record.id,
          record.kind,
          record.name,
          record.description,
          record.source,
          record.sourceRef,
          record.version,
          record.enabled ? 1 : 0,
          JSON.stringify(record.config ?? {}),
          record.installedAt,
          record.updatedAt,
          record.installedBy,
        );
    },

    insertStrict(record) {
      database
        .prepare(
          `INSERT INTO capabilities
           (id, kind, name, description, source, source_ref, version, enabled, config_json, installed_at, updated_at, installed_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.kind,
          record.name,
          record.description,
          record.source,
          record.sourceRef,
          record.version,
          record.enabled ? 1 : 0,
          JSON.stringify(record.config ?? {}),
          record.installedAt,
          record.updatedAt,
          record.installedBy,
        );
    },

    update(kind, id, patch) {
      const current = database.prepare('SELECT * FROM capabilities WHERE kind = ? AND id = ?').get(kind, id);
      if (!current) return;
      const merged = rowToCapability(current);
      const updated: CapabilityRecord = {
        ...merged,
        ...patch,
        config: { ...merged.config, ...(patch.config ?? {}) },
        updatedAt: new Date().toISOString(),
      };
      database
        .prepare(
          `UPDATE capabilities SET
            name = ?, description = ?, source = ?, source_ref = ?, version = ?, enabled = ?, config_json = ?, updated_at = ?
           WHERE kind = ? AND id = ?`,
        )
        .run(
          updated.name,
          updated.description,
          updated.source,
          updated.sourceRef,
          updated.version,
          updated.enabled ? 1 : 0,
          JSON.stringify(updated.config),
          updated.updatedAt,
          kind,
          id,
        );
    },

    remove(kind, id) {
      const result = database.prepare('DELETE FROM capabilities WHERE kind = ? AND id = ?').run(kind, id);
      return result.changes > 0;
    },

    setEnabled(kind, id, enabled) {
      database
        .prepare('UPDATE capabilities SET enabled = ?, updated_at = ? WHERE kind = ? AND id = ?')
        .run(enabled ? 1 : 0, new Date().toISOString(), kind, id);
    },

    close() {
      database.close();
    },
  };
}

function rowToCapability(row: Record<string, unknown>): CapabilityRecord {
  return {
    id: String(row.id),
    kind: String(row.kind) as CapabilityKind,
    name: String(row.name),
    description: String(row.description),
    source: String(row.source) as CapabilitySource,
    sourceRef: String(row.source_ref),
    version: (row.version as string | null) ?? null,
    enabled: Boolean(row.enabled),
    config: parseConfig(row.config_json),
    installedAt: String(row.installed_at),
    updatedAt: String(row.updated_at),
    installedBy: String(row.installed_by) as CapabilityInstalledBy,
  };
}

function parseConfig(value: unknown): CapabilityConfig {
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null ? (parsed as CapabilityConfig) : {};
  } catch {
    return {};
  }
}