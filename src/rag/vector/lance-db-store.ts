import { connect, makeArrowTable, Index } from '@lancedb/lancedb';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface VectorRecord {
  id: string;
  chunk_key?: string;
  source: string;
  title: string;
  content: string;
  vector: number[];
  actor_id?: string;
  conversation_id?: string;
  session_name?: string;
  thread_id?: string;
  metadata: Record<string, unknown>;
  updated_at: string;
}

export interface VectorSearchOptions {
  limit?: number;
  filters?: Record<string, unknown>;
}

export interface VectorSearchResult {
  id: string;
  chunk_key?: string;
  source: string;
  title: string;
  content: string;
  score: number;
  metadata: Record<string, unknown>;
  updated_at: string;
}

export interface VectorStore {
  upsert(collection: string, records: VectorRecord[]): Promise<void>;
  search(collection: string, query: number[], options?: VectorSearchOptions): Promise<VectorSearchResult[]>;
  searchKeyword(collection: string, query: string, options?: VectorSearchOptions): Promise<VectorSearchResult[]>;
  delete(collection: string, ids: string[]): Promise<void>;
  listIds(collection: string): Promise<string[]>;
  /** Returns the vector dimension of an existing collection, or undefined if the collection does not exist or is empty. */
  getVectorDimension(collection: string): Promise<number | undefined>;
}

export interface LanceDbVectorStoreOptions {
  path?: string;
}

export const defaultVectorStorePath = '.gorombo/vector';

export class LanceDbVectorStore implements VectorStore {
  private readonly resolvedPath: string;
  private connection: Awaited<ReturnType<typeof connect>> | undefined;

  constructor(options: LanceDbVectorStoreOptions = {}) {
    this.resolvedPath = resolveRuntimePath(options.path ?? defaultVectorStorePath);
  }

  async upsert(collection: string, records: VectorRecord[]): Promise<void> {
    if (records.length === 0) {
      return;
    }

    const ids = records.map((record) => record.id).filter(Boolean);
    const arrowRecords = makeArrowTable(records as unknown as Record<string, unknown>[]);
    const table = await this.openOrCreateTable(collection, records);

    if (ids.length > 0) {
      await table.delete(createIdFilter(ids));
    }

    await table.add(arrowRecords);
    await this.ensureKeywordIndex(collection, table);
  }

  async search(collection: string, query: number[], options: VectorSearchOptions = {}): Promise<VectorSearchResult[]> {
    const table = await this.openTable(collection);
    if (!table) {
      return [];
    }

    const builder = table.query().nearestTo(query);
    if (options.limit) {
      builder.limit(Math.max(1, Math.floor(options.limit)));
    }

    const filter = buildLanceFilter(options.filters);
    if (filter) {
      builder.where(filter);
    }

    const rows = (await builder.toArray()) as unknown as Array<LanceSearchRow>;
    return rows.map(toSearchResult);
  }

  async searchKeyword(collection: string, query: string, options: VectorSearchOptions = {}): Promise<VectorSearchResult[]> {
    const table = await this.openTable(collection);
    if (!table) {
      return [];
    }

    await this.ensureKeywordIndex(collection, table);

    const builder = table.query().fullTextSearch(query, { columns: ['content'] });
    if (options.limit) {
      builder.limit(Math.max(1, Math.floor(options.limit)));
    }

    const filter = buildLanceFilter(options.filters);
    if (filter) {
      builder.where(filter);
    }

    const rows = (await builder.toArray()) as unknown as Array<LanceKeywordRow>;
    return rows.map(toKeywordResult);
  }

  async delete(collection: string, ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    const table = await this.openTable(collection);
    if (!table) {
      return;
    }

    await table.delete(createIdFilter(ids));
  }

  private async getConnection() {
    if (!this.connection) {
      mkdirSync(dirname(this.resolvedPath), { recursive: true });
      mkdirSync(this.resolvedPath, { recursive: true });
      this.connection = await connect(this.resolvedPath);
    }

    return this.connection;
  }

  private async openTable(collection: string) {
    const db = await this.getConnection();
    const names = await db.tableNames();
    if (!names.includes(collection)) {
      return undefined;
    }

    return db.openTable(collection);
  }

  private async openOrCreateTable(collection: string, sampleRecords: VectorRecord[]) {
    const db = await this.getConnection();
    const names = await db.tableNames();
    if (names.includes(collection)) {
      const table = await db.openTable(collection);
      await this.ensureKeywordIndex(collection, table);
      return table;
    }

    try {
      const table = await db.createTable(
        collection,
        makeArrowTable(sampleRecords as unknown as Record<string, unknown>[]),
      );
      await this.ensureKeywordIndex(collection, table);
      return table;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/already exists/i.test(message)) {
        const table = await db.openTable(collection);
        await this.ensureKeywordIndex(collection, table);
        return table;
      }
      throw error;
    }
  }

  private async ensureKeywordIndex(_collection: string, table: Awaited<ReturnType<typeof this.openTable>>): Promise<void> {
    if (!table) {
      return;
    }
    await this.ensureFtsIndex(table, 'content');
    await this.ensureFtsIndex(table, 'title');
  }

  private async ensureFtsIndex(table: Awaited<ReturnType<typeof this.openTable>>, column: string): Promise<void> {
    if (!table) {
      return;
    }
    try {
      await table.createIndex(column, { config: Index.fts() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/already exists/i.test(message)) {
        console.error(`[WARN] Failed to create FTS index on ${column}:`, message);
      }
    }
  }

  async listIds(collection: string): Promise<string[]> {
    const table = await this.openTable(collection);
    if (!table) {
      return [];
    }

    const rows = (await table.query().select(['id']).toArray()) as unknown as Array<{ id: string }>;
    return rows.map((row) => String(row.id));
  }

  async getVectorDimension(collection: string): Promise<number | undefined> {
    const table = await this.openTable(collection);
    if (!table) {
      return undefined;
    }

    try {
      const rows = (await table.query().select(['vector']).limit(1).toArray()) as unknown as Array<{ vector?: number[] }>;
      const vector = rows[0]?.vector;
      if (Array.isArray(vector) && vector.length > 0) {
        return vector.length;
      }
    } catch {
      // Collection exists but has no readable vector column or is empty.
    }

    return undefined;
  }
}

function resolveRuntimePath(value: string): string {
  return resolve(value);
}

function createIdFilter(ids: string[]): string {
  const escaped = ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');
  return `id IN (${escaped})`;
}

function buildLanceFilter(filters: Record<string, unknown> | undefined): string | undefined {
  if (!filters) {
    return undefined;
  }

  const expressions: string[] = [];
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null) {
      continue;
    }

    if (Array.isArray(value)) {
      const escaped = value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => `'${item.replace(/'/g, "''")}'`)
        .join(', ');
      if (escaped) {
        expressions.push(`${key} IN (${escaped})`);
      }
      continue;
    }

    if (typeof value === 'string') {
      expressions.push(`${key} = '${value.replace(/'/g, "''")}'`);
      continue;
    }

    if (typeof value === 'boolean' || typeof value === 'number') {
      expressions.push(`${key} = ${value}`);
      continue;
    }
  }

  return expressions.length ? expressions.join(' AND ') : undefined;
}

interface LanceSearchRow {
  id: string;
  chunk_key?: string;
  source: string;
  title: string;
  content: string;
  _distance?: number;
  metadata?: string | Record<string, unknown>;
  updated_at: string;
}

interface LanceKeywordRow {
  id: string;
  chunk_key?: string;
  source: string;
  title: string;
  content: string;
  _score?: number;
  _rank?: number;
  metadata?: string | Record<string, unknown>;
  updated_at: string;
}

function toSearchResult(row: LanceSearchRow): VectorSearchResult {
  const metadata = parseMetadata(row.metadata);
  const distance = typeof row._distance === 'number' ? row._distance : 0;
  const score = Math.max(0, Math.min(1, 1 / (1 + Math.abs(distance))));

  return {
    id: String(row.id),
    chunk_key: row.chunk_key,
    source: String(row.source),
    title: String(row.title),
    content: String(row.content),
    score,
    metadata,
    updated_at: String(row.updated_at),
  };
}

function toKeywordResult(row: LanceKeywordRow): VectorSearchResult {
  const metadata = parseMetadata(row.metadata);
  let score: number;
  if (typeof row._score === 'number') {
    score = row._score;
  } else {
    const rank = typeof row._rank === 'number' ? row._rank : 0;
    score = Math.max(0, Math.min(1, 1 / (1 + Math.abs(rank))));
  }

  return {
    id: String(row.id),
    chunk_key: row.chunk_key,
    source: String(row.source),
    title: String(row.title),
    content: String(row.content),
    score,
    metadata,
    updated_at: String(row.updated_at),
  };
}

function parseMetadata(value: string | Record<string, unknown> | undefined): Record<string, unknown> {
  if (!value) {
    return {};
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  return value;
}
