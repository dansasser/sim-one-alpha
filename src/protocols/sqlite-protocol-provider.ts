import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { NormalizedMessageEvent, ProtocolBundle, ProtocolDefinition, ProtocolSelector } from '../types/index.js';
import { baseProtocolSeeds, type ProtocolProvider } from './protocol-provider.js';
import { protocolSchemaSql } from './schema.js';

export const defaultProtocolDatabasePath = '.gorombo/db/protocols.sqlite';

export interface AddProtocolInput {
  id: string;
  name: string;
  description: string;
  priority?: number;
  appliesTo?: ProtocolSelector;
  rules: string[];
  enabled?: boolean;
  tags?: string[];
}

export class SqliteProtocolProvider implements ProtocolProvider {
  private readonly database: DatabaseSync;

  constructor(readonly dbPath = defaultProtocolDatabasePath) {
    const resolved = resolveRuntimePath(dbPath);
    mkdirSync(dirname(resolved), { recursive: true });
    this.database = new DatabaseSync(resolved, { timeout: 5_000 });
    this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
    this.migrate();
    this.seedBaseProtocols();
  }

  close(): void {
    this.database.close();
  }

  migrate(): void {
    this.database.exec(protocolSchemaSql);
    try {
      this.database.exec(`ALTER TABLE protocols ADD COLUMN tags TEXT`);
    } catch {
      // Column already exists; ignore.
    }
  }

  seedBaseProtocols(): void {
    const row = this.database.prepare(`SELECT COUNT(*) AS c FROM protocols WHERE source = 'seed'`).get() as { c: number } | undefined;
    if ((row?.c ?? 0) > 0) {
      return;
    }

    const insert = this.database.prepare(
      `INSERT INTO protocols
       (id, name, description, scope, enabled, priority, selector_json, rules_json, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const protocol of baseProtocolSeeds) {
      insert.run(
        protocol.id,
        protocol.name,
        protocol.description,
        protocol.scope,
        protocol.enabled ? 1 : 0,
        protocol.priority,
        JSON.stringify(protocol.appliesTo),
        JSON.stringify(protocol.rules),
        protocol.source,
        new Date().toISOString(),
        new Date().toISOString(),
      );
    }
  }

  async loadApplicable(event: NormalizedMessageEvent): Promise<ProtocolBundle> {
    const rows = this.database
      .prepare(
        `SELECT id, name, description, scope, enabled, priority, selector_json, rules_json, source, tags
         FROM protocols
         WHERE enabled = 1
         ORDER BY priority DESC`,
      )
      .all() as unknown as ProtocolRow[];

    const protocols = rows
      .map((row) => rowToProtocol(row))
      .filter((protocol) => protocolApplies(protocol, event));

    return {
      eventId: event.id,
      protocols: protocols.map(cloneProtocol),
      loadedAt: new Date().toISOString(),
    };
  }

  listSeedProtocols(): ProtocolDefinition[] {
    return baseProtocolSeeds.map(cloneProtocol);
  }

  listProtocols(): ProtocolDefinition[] {
    const rows = this.database
      .prepare(
        `SELECT id, name, description, scope, enabled, priority, selector_json, rules_json, source, tags
         FROM protocols
         ORDER BY priority DESC, id ASC`,
      )
      .all() as unknown as ProtocolRow[];

    return rows.map((row) => cloneProtocol(rowToProtocol(row)));
  }

  addProtocol(input: AddProtocolInput): ProtocolDefinition {
    const existing = this.getProtocol(input.id);
    const isBase = existing?.scope === 'base';

    const protocol: ProtocolDefinition = {
      id: input.id,
      name: input.name,
      description: input.description,
      scope: 'user',
      enabled: input.enabled ?? true,
      priority: input.priority ?? 0,
      appliesTo: input.appliesTo ?? {},
      rules: [...input.rules],
      source: 'sqlite',
      tags: input.tags ? [...input.tags] : undefined,
    };

    this.database
      .prepare(
        `INSERT INTO protocols
         (id, name, description, scope, enabled, priority, selector_json, rules_json, source, tags, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           scope = excluded.scope,
           enabled = excluded.enabled,
           priority = excluded.priority,
           selector_json = excluded.selector_json,
           rules_json = excluded.rules_json,
           source = excluded.source,
           tags = excluded.tags,
           updated_at = excluded.updated_at`,
      )
      .run(
        protocol.id,
        protocol.name,
        protocol.description,
        protocol.scope,
        protocol.enabled ? 1 : 0,
        protocol.priority,
        JSON.stringify(protocol.appliesTo),
        JSON.stringify(protocol.rules),
        protocol.source,
        protocol.tags ? JSON.stringify(protocol.tags) : null,
        new Date().toISOString(),
        new Date().toISOString(),
      );

    return cloneProtocol(protocol);
  }

  removeProtocol(id: string): boolean {
    const existing = this.getProtocol(id);
    if (existing && existing.scope === 'base') {
      throw new Error(`Cannot remove base protocol ${id}.`);
    }

    const result = this.database.prepare(`DELETE FROM protocols WHERE id = ? AND scope = 'user'`).run(id);
    return result.changes > 0;
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const existing = this.getProtocol(id);
    if (!existing) {
      return false;
    }

    const result = this.database
      .prepare(`UPDATE protocols SET enabled = ?, updated_at = ? WHERE id = ?`)
      .run(enabled ? 1 : 0, new Date().toISOString(), id);
    return result.changes > 0;
  }

  getProtocol(id: string): ProtocolDefinition | undefined {
    const row = this.database
      .prepare(
        `SELECT id, name, description, scope, enabled, priority, selector_json, rules_json, source, tags
         FROM protocols
         WHERE id = ?`,
      )
      .get(id) as ProtocolRow | undefined;

    if (!row) {
      return undefined;
    }

    return cloneProtocol(rowToProtocol(row));
  }
}

interface ProtocolRow {
  id: string;
  name: string;
  description: string;
  scope: string;
  enabled: number;
  priority: number;
  selector_json: string;
  rules_json: string;
  source: string;
  tags: string | null;
}

function rowToProtocol(row: ProtocolRow): ProtocolDefinition {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    scope: row.scope as 'base' | 'user',
    enabled: Boolean(row.enabled),
    priority: row.priority,
    appliesTo: parseJsonObject(row.selector_json),
    rules: parseJsonStringArray(row.rules_json),
    source: row.source as 'sqlite' | 'file' | 'seed',
    tags: row.tags ? parseJsonStringArray(row.tags) : undefined,
  };
}

function protocolApplies(protocol: ProtocolDefinition, event: NormalizedMessageEvent): boolean {
  const selector = protocol.appliesTo;

  return (
    matches(selector.connector, event.connector) &&
    matches(selector.messageKind, event.kind) &&
    matches(selector.userId, event.actor.id) &&
    matches(selector.clientId, event.context?.clientId) &&
    matches(selector.projectId, event.context?.projectId) &&
    matches(selector.workflow, event.context?.workflow) &&
    matches(selector.task, event.context?.task)
  );
}

function matches(expected: string | undefined, actual: string | undefined): boolean {
  return expected === undefined || expected === actual;
}

function cloneProtocol(protocol: ProtocolDefinition): ProtocolDefinition {
  return {
    ...protocol,
    appliesTo: { ...protocol.appliesTo },
    rules: [...protocol.rules],
    ...(protocol.tags ? { tags: [...protocol.tags] } : {}),
  };
}

function parseJsonObject<T>(value: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return {} as T;
  }
}

function parseJsonStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function resolveRuntimePath(filePath: string): string {
  return isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);
}
