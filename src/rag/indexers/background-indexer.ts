import { resolve } from 'node:path';
import type { EmbeddingClient } from '../embeddings.js';
import { getOnnxEmbeddingDimensions } from '../../embeddings/index.js';
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
      const idsToKeep = new Set(records.map((record) => record.id).filter(Boolean));

      if (records.length === 0) {
        const existingIds = await options.vectorStore.listIds(collection);
        const staleIds = existingIds.filter((id) => !idsToKeep.has(id));
        if (staleIds.length > 0) {
          await options.vectorStore.delete(collection, staleIds);
        }
        return;
      }

      const contents = records.map((record) => record.content);
      const outcome = await options.embeddingClient.embedBatchWithOutcome(contents);

      let vectorRecords: Array<{
        id: string;
        chunk_key?: string;
        source: string;
        title: string;
        content: string;
        vector: number[];
        metadata: Record<string, unknown>;
        updated_at: string;
      }>;
      if (outcome.ok) {
        vectorRecords = records.map((record, index) => ({
          ...record,
          vector: outcome.result.vectors[index] ?? [],
        }));
      } else {
        console.error(
          `[WARN] Background indexing embedding failed for ${collection}: ${outcome.error}`,
        );
        const dimensions = await getOnnxEmbeddingDimensions();
        vectorRecords = records.map((record) => ({
          ...record,
          vector: new Array(dimensions).fill(0),
          metadata: {
            ...record.metadata,
            embeddingError: outcome.error,
          },
        }));
      }

      await options.vectorStore.upsert(collection, vectorRecords);

      const existingIds = await options.vectorStore.listIds(collection);
      const staleIds = existingIds.filter((id) => !idsToKeep.has(id));
      if (staleIds.length > 0) {
        await options.vectorStore.delete(collection, staleIds);
      }
    } catch (error) {
      console.error(
        `[WARN] Background indexing failed for ${collection}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
