import { resolve } from 'node:path';
import type { EmbeddingClient } from '../embeddings.js';
import type { VectorStore } from '../vector/index.js';
import { indexKnowledgeDocs } from './knowledge-doc-indexer.js';
import { indexProjectFiles } from './project-file-indexer.js';

export interface BackgroundIndexerOptions {
  vectorStore: VectorStore;
  embeddingClient: EmbeddingClient;
  projectRoot?: string;
  workspaceRoot?: string;
}

export async function runBackgroundIndexing(options: BackgroundIndexerOptions): Promise<void> {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const workspaceRoot = options.workspaceRoot ? resolve(options.workspaceRoot) : projectRoot;

  await indexCollection('knowledge_docs', async () => {
    const records = await indexKnowledgeDocs({ projectRoot });
    return records.map((record) => ({ ...record, source: 'knowledge_doc' }));
  });

  await indexCollection('project_files', async () => {
    return indexProjectFiles({ workspaceRoot });
  });

  async function indexCollection(collection: string, loadRecords: () => Promise<Array<{
    id: string;
    chunk_key?: string;
    source: string;
    title: string;
    content: string;
    vector: number[];
    metadata: Record<string, unknown>;
    updated_at: string;
  }>>): Promise<void> {
    try {
      const records = await loadRecords();
      if (records.length === 0) {
        await options.vectorStore.delete(collection, []);
        return;
      }

      const idsToKeep = new Set(records.map((record) => record.id).filter(Boolean));

      const existing = await options.vectorStore.search(collection, new Array(1).fill(0), { limit: 100_000 });
      const staleIds = existing
        .filter((row) => !idsToKeep.has(row.id))
        .map((row) => row.id);
      if (staleIds.length > 0) {
        await options.vectorStore.delete(collection, staleIds);
      }

      const contents = records.map((record) => record.content);
      const vectors = await options.embeddingClient.embedBatch(contents);
      const vectorRecords = records.map((record, index) => ({
        ...record,
        vector: vectors[index] ?? [],
      }));

      await options.vectorStore.upsert(collection, vectorRecords);
    } catch (error) {
      console.error(
        `[WARN] Background indexing failed for ${collection}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
