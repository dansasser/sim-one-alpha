import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { SqliteResearchCache } from '../workers/researcher/research/research-cache.js';

test('SQLite research cache treats corrupted JSON rows as cache misses', async () => {
  const filePath = join(mkdtempSync(join(tmpdir(), 'gorombo-research-cache-')), 'cache.sqlite');
  const setup = new SqliteResearchCache(filePath);
  setup.close();

  const database = new DatabaseSync(filePath);
  const future = '2999-01-01T00:00:00.000Z';
  database
    .prepare(
      `INSERT INTO research_search_cache
       (key, query, provider, limit_value, contexts_json, retrieved_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('bad-search', 'query', 'test-provider', 1, '{bad json', '2026-06-09T00:00:00.000Z', future);
  database
    .prepare(
      `INSERT INTO research_page_cache
       (url, page_json, content_hash, retrieved_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run('https://example.com/bad', '{bad json', 'hash', '2026-06-09T00:00:00.000Z', future);
  database.close();

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };

  const cache = new SqliteResearchCache(filePath);
  try {
    assert.equal(await cache.getSearch('bad-search'), null);
    assert.equal(await cache.getPage('https://example.com/bad'), null);
  } finally {
    cache.close();
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 2);
  assert.match(warnings[0] ?? '', /bad-search/);
  assert.match(warnings[1] ?? '', /https:\/\/example\.com\/bad/);
});
