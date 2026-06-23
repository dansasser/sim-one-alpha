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

      // Embed in batches to avoid OOM from native ONNX tensor arena + LanceDB Arrow buffers.
      // The previous code embedded the entire corpus in a single embedBatchWithOutcome() call,
      // which allocated ~20GB of native memory and OOM-killed the process every 3-7 minutes.
      const BATCH_SIZE = 32;
      const vectorRecords: Array<{
        id: string;
        chunk_key?: string;
        source: string;
        title: string;
        content: string;
        vector: number[];
        metadata: Record<string, unknown>;
        updated_at: string;
      }> = [];

      for (let offset = 0; offset < records.length; offset += BATCH_SIZE) {
        const batch = records.slice(offset, offset + BATCH_SIZE);
        const batchContents = batch.map((record) => record.content);
        const outcome = await options.embeddingClient.embedBatchWithOutcome(batchContents);

        if (outcome.ok) {
          if (outcome.result.vectors.length !== batch.length) {
            throw new Error(
              `Embedding provider returned ${outcome.result.vectors.length} vectors for ${batch.length} records (batch at offset ${offset})`,
            );
          }
          for (let i = 0; i < batch.length; i++) {
            vectorRecords.push({ ...batch[i], vector: outcome.result.vectors[i] });
          }
        } else {
          console.error(
            `[WARN] Background indexing embedding failed for ${collection} (batch at offset ${offset}): ${outcome.error}`,
          );
          const dimensions = await getOnnxEmbeddingDimensions();
          for (const record of batch) {
            vectorRecords.push({
              ...record,
              vector: new Array(dimensions).fill(0),
              metadata: { ...record.metadata, embeddingError: outcome.error },
            });
          }
        }
      }

      // Upsert in batches too, to avoid building one massive Arrow buffer.
      for (let offset = 0; offset < vectorRecords.length; offset += BATCH_SIZE) {
        const batch = vectorRecords.slice(offset, offset + BATCH_SIZE);
        await options.vectorStore.upsert(collection, batch);
      }

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
