import assert from 'node:assert/strict';
import test from 'node:test';
import { DocumentIndexProvider } from '../rag/document-index-provider.js';

test('document-index provider skips unscoped knowledge_base queries', async () => {
  const searches: Array<{ collection: string; query: number[]; options: unknown }> = [];
  const keywordSearches: Array<{ collection: string; query: string; options: unknown }> = [];
  const vectorStore = {
    upsert: async () => {},
    search: async (collection: string, query: number[], options: unknown) => {
      searches.push({ collection, query, options });
      return [];
    },
    searchKeyword: async (collection: string, query: string, options: unknown) => {
      keywordSearches.push({ collection, query, options });
      return [];
    },
    delete: async () => {},
    listIds: async () => [],
    getVectorDimension: async () => undefined,
  };
  const embeddingClient: import('../rag/embeddings.js').EmbeddingClient = {
    embed: async () => [1, 2, 3],
    embedBatch: async () => [],
    embedWithOutcome: async () => ({ ok: true as const, result: { vector: [1, 2, 3], provider: 'onnx-local' as const, modelId: 'all-minilm-l6-v2' } }),
    embedBatchWithOutcome: async () => ({ ok: true as const, result: { vectors: [], provider: 'onnx-local' as const, modelId: 'all-minilm-l6-v2' } }),
  };
  const provider = new DocumentIndexProvider({ vectorStore, embeddingClient });

  const results = await provider.retrieve({
    eventId: 'event-1',
    text: 'query',
    actorId: '',
    conversationId: '',
    limit: 5,
    caller: 'orchestrator',
  });

  assert.equal(results.length, 0);
  assert.equal(
    searches.find((s) => s.collection === 'knowledge_base'),
    undefined,
    'knowledge_base vector search should be skipped without scope',
  );
  assert.equal(
    keywordSearches.find((s) => s.collection === 'knowledge_base'),
    undefined,
    'knowledge_base keyword search should be skipped without scope',
  );
  assert.ok(searches.some((s) => s.collection === 'project_files'), 'other collections should still be searched in vector mode');
  assert.ok(
    keywordSearches.some((s) => s.collection === 'project_files'),
    'other collections should still be searched in keyword fallback mode',
  );
});

test('document-index provider allows scoped knowledge_base queries', async () => {
  const searches: Array<{ collection: string; query: number[]; options: unknown }> = [];
  const keywordSearches: Array<{ collection: string; query: string; options: unknown }> = [];
  const vectorStore = {
    upsert: async () => {},
    search: async (collection: string, query: number[], options: unknown) => {
      searches.push({ collection, query, options });
      return [];
    },
    searchKeyword: async (collection: string, query: string, options: unknown) => {
      keywordSearches.push({ collection, query, options });
      return [];
    },
    delete: async () => {},
    listIds: async () => [],
    getVectorDimension: async () => undefined,
  };
  const embeddingClient: import('../rag/embeddings.js').EmbeddingClient = {
    embed: async () => [1, 2, 3],
    embedBatch: async () => [],
    embedWithOutcome: async () => ({ ok: true as const, result: { vector: [1, 2, 3], provider: 'onnx-local' as const, modelId: 'all-minilm-l6-v2' } }),
    embedBatchWithOutcome: async () => ({ ok: true as const, result: { vectors: [], provider: 'onnx-local' as const, modelId: 'all-minilm-l6-v2' } }),
  };
  const provider = new DocumentIndexProvider({ vectorStore, embeddingClient });

  const results = await provider.retrieve({
    eventId: 'event-1',
    text: 'query',
    actorId: 'user-1',
    conversationId: 'thread-1',
    limit: 5,
    caller: 'orchestrator',
  });

  assert.equal(results.length, 0);
  const knowledgeSearch = searches.find((s) => s.collection === 'knowledge_base');
  assert.ok(knowledgeSearch, 'knowledge_base collection should be searched in vector mode');
  assert.deepEqual((knowledgeSearch.options as { filters?: Record<string, unknown> }).filters, {
    actor_id: 'user-1',
    conversation_id: 'thread-1',
  });

  const keywordKnowledgeSearch = keywordSearches.find((s) => s.collection === 'knowledge_base');
  assert.ok(keywordKnowledgeSearch, 'knowledge_base collection should be searched in keyword fallback mode');
  assert.deepEqual((keywordKnowledgeSearch.options as { filters?: Record<string, unknown> }).filters, {
    actor_id: 'user-1',
    conversation_id: 'thread-1',
  });
});
