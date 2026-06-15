import type { EmbeddingClient } from './embeddings.js';
import type { RagProvider } from './providers.js';
import type { RagQuery, RetrievedContext } from '../types/index.js';
import type { VectorStore, VectorSearchResult } from './vector/index.js';

export interface DocumentIndexProviderOptions {
  vectorStore: VectorStore;
  embeddingClient: EmbeddingClient;
  collections?: string[];
}

export class DocumentIndexProvider implements RagProvider {
  readonly id = 'document-index' as const;
  readonly name = 'lancedb-document-index';

  private readonly vectorStore: VectorStore;
  private readonly embeddingClient: EmbeddingClient;
  private readonly collections: string[];

  constructor(options: DocumentIndexProviderOptions) {
    this.vectorStore = options.vectorStore;
    this.embeddingClient = options.embeddingClient;
    this.collections = options.collections ?? ['project_files', 'knowledge_docs', 'knowledge_base'];
  }

  async retrieve(query: RagQuery): Promise<RetrievedContext[]> {
    if (!query.text.trim()) {
      return [];
    }

    const vector = await this.embeddingClient.embed(query.text);
    const limit = readLimit(query.limit);
    const perCollection = Math.max(1, Math.ceil(limit / this.collections.length));
    const allResults: VectorSearchResult[] = [];

    for (const collection of this.collections) {
      try {
        const results = await this.vectorStore.search(collection, vector, { limit: perCollection });
        allResults.push(...results);
      } catch (error) {
        // Collection may not exist yet. Log and continue.
        console.error(
          '[WARN] Document index search failed for collection',
          collection,
          ':',
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    return allResults
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map((result) => ({
        id: `doc:${result.id}`,
        provider: 'document-index' as const,
        title: result.title,
        content: result.content,
        score: result.score,
        metadata: {
          ...result.metadata,
          collection: result.metadata?.collection ?? inferCollection(result.source),
          source: result.source,
          updatedAt: result.updated_at,
        },
      }));
  }
}

function inferCollection(source: string): string {
  if (source === 'project_file') {
    return 'project_files';
  }
  if (source === 'knowledge_doc') {
    return 'knowledge_docs';
  }
  if (source === 'agent_knowledge' || source === 'knowledge_base') {
    return 'knowledge_base';
  }
  return 'unknown';
}

function readLimit(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 5;
}
