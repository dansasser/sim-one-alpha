import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { SessionData } from '@flue/runtime/adapter';
import { LanceDbVectorStore } from '../rag/vector/lance-db-store.js';
import { GoromboSessionDatabase } from '../session/session-database.js';

const fakeEmbeddingClient = {
  async embed(): Promise<number[]> {
    return new Array(384).fill(0.1);
  },
  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map(() => new Array(384).fill(0.1));
  },
  async embedWithOutcome(): Promise<{ ok: true; result: { vector: number[]; provider: 'onnx-local'; modelId: string } }> {
    return { ok: true, result: { vector: new Array(384).fill(0.1), provider: 'onnx-local' as const, modelId: 'all-minilm-l6-v2' } };
  },
  async embedBatchWithOutcome(texts: string[]): Promise<{ ok: true; result: { vectors: number[][]; provider: 'onnx-local'; modelId: string } }> {
    return { ok: true, result: { vectors: texts.map(() => new Array(384).fill(0.1)), provider: 'onnx-local' as const, modelId: 'all-minilm-l6-v2' } };
  },
};

function makeSessionData(content: string): SessionData {
  return {
    version: 6,
    affinityKey: 'test',
    leafId: 'leaf-1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    entries: [
      {
        id: 'entry-1',
        type: 'message',
        timestamp: new Date().toISOString(),
        parentId: 'root',
        message: { role: 'user', content, timestamp: Date.now() },
      },
    ],
    metadata: {},
    taskSessions: [],
  };
}

test('recordFlueSession indexes session chunks into the vector store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gorombo-session-vector-test-'));
  const vectorStore = new LanceDbVectorStore({ path: dir });
  const db = new GoromboSessionDatabase(join(dir, 'sessions.sqlite'), {
    vectorStore,
    embeddingClient: fakeEmbeddingClient,
  });

  try {
    await db.recordFlueSession('agent-session:["instance-1","harness-1","session-1"]', makeSessionData('remember this detail'));

    const results = await vectorStore.search('session_memory', new Array(384).fill(0.1), { limit: 5 });
    assert.ok(results.length > 0);
    assert.ok(results.some((result) => result.content.includes('remember this detail')));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
