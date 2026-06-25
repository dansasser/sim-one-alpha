import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { WebFetchResult } from '../../../../engine/rag/providers.js';
import type { RetrievedContext } from '../../../../core/types/index.js';

export interface CachedSearchResult {
  key: string;
  query: string;
  provider: string;
  limit: number;
  contexts: RetrievedContext[];
  retrievedAt: string;
  expiresAt: string;
}

export interface CachedPageResult {
  url: string;
  page: WebFetchResult;
  retrievedAt: string;
  expiresAt: string;
}

export interface ResearchCacheStats {
  searchHits: number;
  searchMisses: number;
  pageHits: number;
  pageMisses: number;
}

export interface ResearchCache {
  getSearch(key: string, now?: Date): Promise<CachedSearchResult | null>;
  setSearch(entry: CachedSearchResult): Promise<void>;
  getPage(url: string, now?: Date): Promise<CachedPageResult | null>;
  setPage(entry: CachedPageResult): Promise<void>;
  close?(): void | Promise<void>;
}

export class InMemoryResearchCache implements ResearchCache {
  private readonly searches = new Map<string, CachedSearchResult>();
  private readonly pages = new Map<string, CachedPageResult>();

  async getSearch(key: string, now = new Date()): Promise<CachedSearchResult | null> {
    const entry = this.searches.get(key) ?? null;
    return entry && !isExpired(entry.expiresAt, now) ? entry : null;
  }

  async setSearch(entry: CachedSearchResult): Promise<void> {
    this.searches.set(entry.key, entry);
  }

  async getPage(url: string, now = new Date()): Promise<CachedPageResult | null> {
    const entry = this.pages.get(url) ?? null;
    return entry && !isExpired(entry.expiresAt, now) ? entry : null;
  }

  async setPage(entry: CachedPageResult): Promise<void> {
    this.pages.set(entry.url, entry);
  }
}

export class ResearchRunCache implements ResearchCache {
  readonly stats: ResearchCacheStats = {
    searchHits: 0,
    searchMisses: 0,
    pageHits: 0,
    pageMisses: 0,
  };

  private readonly runSearches = new Map<string, CachedSearchResult>();
  private readonly runPages = new Map<string, CachedPageResult>();

  constructor(private readonly persistent: ResearchCache = new InMemoryResearchCache()) {}

  async getSearch(key: string, now = new Date()): Promise<CachedSearchResult | null> {
    const runEntry = this.runSearches.get(key) ?? null;
    if (runEntry && !isExpired(runEntry.expiresAt, now)) {
      this.stats.searchHits += 1;
      return runEntry;
    }

    const storedEntry = await this.persistent.getSearch(key, now);
    if (storedEntry) {
      this.runSearches.set(key, storedEntry);
      this.stats.searchHits += 1;
      return storedEntry;
    }

    this.stats.searchMisses += 1;
    return null;
  }

  async setSearch(entry: CachedSearchResult): Promise<void> {
    this.runSearches.set(entry.key, entry);
    await this.persistent.setSearch(entry);
  }

  async getPage(url: string, now = new Date()): Promise<CachedPageResult | null> {
    const runEntry = this.runPages.get(url) ?? null;
    if (runEntry && !isExpired(runEntry.expiresAt, now)) {
      this.stats.pageHits += 1;
      return runEntry;
    }

    const storedEntry = await this.persistent.getPage(url, now);
    if (storedEntry) {
      this.runPages.set(url, storedEntry);
      this.stats.pageHits += 1;
      return storedEntry;
    }

    this.stats.pageMisses += 1;
    return null;
  }

  async setPage(entry: CachedPageResult): Promise<void> {
    this.runPages.set(entry.url, entry);
    await this.persistent.setPage(entry);
  }

  async close(): Promise<void> {
    await this.persistent.close?.();
  }
}

export class SqliteResearchCache implements ResearchCache {
  private readonly database: DatabaseSync;

  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.database = new DatabaseSync(filePath);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS research_search_cache (
        key TEXT PRIMARY KEY,
        query TEXT NOT NULL,
        provider TEXT NOT NULL,
        limit_value INTEGER NOT NULL,
        contexts_json TEXT NOT NULL,
        retrieved_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      -- content_hash is kept for later page deduplication and integrity checks.
      CREATE TABLE IF NOT EXISTS research_page_cache (
        url TEXT PRIMARY KEY,
        page_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        retrieved_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
    `);
  }

  async getSearch(key: string, now = new Date()): Promise<CachedSearchResult | null> {
    const row = this.database
      .prepare(
        `SELECT key, query, provider, limit_value, contexts_json, retrieved_at, expires_at
         FROM research_search_cache
         WHERE key = ?`,
      )
      .get(key) as SearchCacheRow | undefined;

    if (!row || isExpired(row.expires_at, now)) {
      return null;
    }

    const contexts = parseJson<RetrievedContext[]>(row.contexts_json, {
      cacheKind: 'search',
      key: row.key,
      provider: row.provider,
    });

    if (!contexts) {
      return null;
    }

    return {
      key: row.key,
      query: row.query,
      provider: row.provider,
      limit: row.limit_value,
      contexts,
      retrievedAt: row.retrieved_at,
      expiresAt: row.expires_at,
    };
  }

  async setSearch(entry: CachedSearchResult): Promise<void> {
    this.database
      .prepare(
        `INSERT OR REPLACE INTO research_search_cache
         (key, query, provider, limit_value, contexts_json, retrieved_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.key,
        entry.query,
        entry.provider,
        entry.limit,
        JSON.stringify(entry.contexts),
        entry.retrievedAt,
        entry.expiresAt,
      );
  }

  async getPage(url: string, now = new Date()): Promise<CachedPageResult | null> {
    const row = this.database
      .prepare(
        `SELECT url, page_json, retrieved_at, expires_at
         FROM research_page_cache
         WHERE url = ?`,
      )
      .get(url) as PageCacheRow | undefined;

    if (!row || isExpired(row.expires_at, now)) {
      return null;
    }

    const page = parseJson<WebFetchResult>(row.page_json, {
      cacheKind: 'page',
      url: row.url,
    });

    if (!page) {
      return null;
    }

    return {
      url: row.url,
      page,
      retrievedAt: row.retrieved_at,
      expiresAt: row.expires_at,
    };
  }

  async setPage(entry: CachedPageResult): Promise<void> {
    this.database
      .prepare(
        `INSERT OR REPLACE INTO research_page_cache
         (url, page_json, content_hash, retrieved_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        entry.url,
        JSON.stringify(entry.page),
        createHash('sha256').update(entry.page.content).digest('hex'),
        entry.retrievedAt,
        entry.expiresAt,
      );
  }

  close(): void {
    this.database.close();
  }
}

export function createDefaultResearchCache(env: Record<string, unknown> = process.env): ResearchCache {
  const mode = readString(env.GOROMBO_RESEARCH_CACHE) ?? 'sqlite';
  if (mode === 'memory') {
    return new InMemoryResearchCache();
  }

  return new SqliteResearchCache(readString(env.GOROMBO_RESEARCH_CACHE_DB) ?? '.gorombo/db/research-cache.sqlite');
}

export function createSearchCacheKey(input: { query: string; provider: string; limit: number }): string {
  return createHash('sha256')
    .update(JSON.stringify({ query: input.query.trim().toLowerCase(), provider: input.provider, limit: input.limit }))
    .digest('hex');
}

export function createExpiresAt(ttlMs: number, now = new Date()): string {
  return new Date(now.getTime() + Math.max(0, ttlMs)).toISOString();
}

function isExpired(expiresAt: string, now: Date): boolean {
  return new Date(expiresAt).getTime() <= now.getTime();
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseJson<T>(
  value: string,
  context: { cacheKind: 'search'; key: string; provider: string } | { cacheKind: 'page'; url: string },
): T | null {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    const details =
      context.cacheKind === 'search'
        ? `key=${context.key} provider=${context.provider}`
        : `url=${context.url}`;
    console.warn(
      `Ignoring corrupted research ${context.cacheKind} cache entry (${details}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

interface SearchCacheRow {
  key: string;
  query: string;
  provider: string;
  limit_value: number;
  contexts_json: string;
  retrieved_at: string;
  expires_at: string;
}

interface PageCacheRow {
  url: string;
  page_json: string;
  retrieved_at: string;
  expires_at: string;
}
