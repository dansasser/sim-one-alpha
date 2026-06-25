import { resolve } from 'node:path';
import type { EmbeddingClient } from '../../../engine/rag/embeddings.js';
import { getOnnxEmbeddingDimensions } from '../../../engine/embeddings/index.js';
import type { VectorStore } from '../../../engine/rag/vector/index.js';
import { indexKnowledgeDocs } from '../../../engine/rag/indexers/knowledge-doc-indexer.js';
import { indexProjectFiles } from '../../../engine/rag/indexers/project-file-indexer.js';

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

      // Embed and upsert in batches to avoid OOM from native ONNX tensor arena + LanceDB Arrow buffers.
      // Each batch is embedded then immediately upserted, so peak memory is bounded by BATCH_SIZE,
      // not by corpus size.
      const BATCH_SIZE = 32;
      let observedDimensions: number | undefined = undefined;

      for (let offset = 0; offset < records.length; offset += BATCH_SIZE) {
        const batch = records.slice(offset, offset + BATCH_SIZE);
        const batchContents = batch.map((record) => record.content);
        const outcome = await options.embeddingClient.embedBatchWithOutcome(batchContents);

        const batchVectorRecords: Array<{
          id: string;
          chunk_key?: string;
          source: string;
          title: string;
          content: string;
          vector: number[];
          metadata: Record<string, unknown>;
          updated_at: string;
        }> = [];

        if (outcome.ok) {
          if (outcome.result.vectors.length !== batch.length) {
            throw new Error(
              `Embedding provider returned ${outcome.result.vectors.length} vectors for ${batch.length} records (batch at offset ${offset})`,
            );
          }
          const firstVector = outcome.result.vectors[0];
          if (firstVector && observedDimensions === undefined) {
            observedDimensions = firstVector.length;
          }
          for (let i = 0; i < batch.length; i++) {
            batchVectorRecords.push({ ...batch[i], vector: outcome.result.vectors[i] });
          }
        } else {
          console.error(
            `[WARN] Background indexing embedding failed for ${collection} (batch at offset ${offset}): ${outcome.error}`,
          );
          const dimensions = observedDimensions ?? (await getOnnxEmbeddingDimensions());
          for (const record of batch) {
            batchVectorRecords.push({
              ...record,
              vector: new Array(dimensions).fill(0),
              metadata: { ...record.metadata, embeddingError: outcome.error },
            });
          }
        }

        await options.vectorStore.upsert(collection, batchVectorRecords);
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
