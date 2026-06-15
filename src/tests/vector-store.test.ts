import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LanceDbVectorStore } from '../rag/vector/lance-db-store.js';

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'gorombo-vector-test-'));
}

test('LanceDbVectorStore stores and searches vectors', async () => {
  const dir = createTempDir();
  const store = new LanceDbVectorStore({ path: dir });

  try {
    await store.upsert('test_collection', [
      createRecord('a', [1, 0, 0]),
      createRecord('b', [0, 1, 0]),
      createRecord('c', [0, 0, 1]),
    ]);

    const results = await store.search('test_collection', [1, 0, 0], { limit: 2 });

    assert.equal(results.length, 2);
    assert.equal(results[0]?.id, 'a');
    assert.ok(results[0]?.score > results[1]?.score);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('LanceDbVectorStore applies metadata filters', async () => {
  const dir = createTempDir();
  const store = new LanceDbVectorStore({ path: dir });

  try {
    await store.upsert('filtered', [
      { ...createRecord('a', [1, 0, 0]), actor_id: 'user-1' },
      { ...createRecord('b', [0, 1, 0]), actor_id: 'user-2' },
    ]);

    const results = await store.search('filtered', [1, 0, 0], {
      limit: 5,
      filters: { actor_id: 'user-1' },
    });

    assert.equal(results.length, 1);
    assert.equal(results[0]?.id, 'a');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createRecord(id: string, vector: number[]) {
  return {
    id,
    source: 'test',
    title: `Record ${id}`,
    content: `Content ${id}`,
    vector,
    metadata: {},
    updated_at: new Date().toISOString(),
  };
}
