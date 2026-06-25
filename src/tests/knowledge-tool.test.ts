import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LanceDbKnowledgeStore } from '../engine/rag/knowledge-store.js';
import { LanceDbVectorStore } from '../engine/rag/vector/lance-db-store.js';

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

function createTestStore() {
  const dir = mkdtempSync(join(tmpdir(), 'gorombo-kb-test-'));
  const vectorStore = new LanceDbVectorStore({ path: dir });
  const store = new LanceDbKnowledgeStore({ vectorStore, embeddingClient: fakeEmbeddingClient });
  return { store, dir };
}

test('LanceDbKnowledgeStore adds a vectorized knowledge record', async () => {
  const { store, dir } = createTestStore();

  try {
    const record = await store.add({
      title: 'Project convention',
      content: 'Use kebab-case for file names.',
      source: 'agent_tool',
      actorId: 'kb-actor',
      conversationId: 'kb-conversation',
      tags: ['conventions'],
      createdBy: 'kb-actor',
    });

    assert.equal(record.title, 'Project convention');
    assert.equal(record.source, 'agent_tool');
    assert.equal(record.createdBy, 'kb-actor');
    assert.deepEqual(record.tags, ['conventions']);
    assert.ok(record.id.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
