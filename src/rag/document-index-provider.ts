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

    const limit = readLimit(query.limit);
    if (limit === 0) {
      return [];
    }

    const outcome = await this.embeddingClient.embedWithOutcome(query.text);
    const perCollection = Math.max(1, Math.ceil(limit / this.collections.length));
    const allResults: VectorSearchResult[] = [];

    if (outcome.ok) {
      for (const collection of this.collections) {
        try {
          const filters = buildCollectionFilters(collection, query);
          if (filters.skip) {
            continue;
          }

          const results = await this.vectorStore.search(collection, outcome.result.vector, {
            limit: perCollection,
            ...(Object.keys(filters.filters).length > 0 ? { filters: filters.filters } : {}),
          });
          allResults.push(...results);
        } catch (error) {
          console.error(
            '[WARN] Document index vector search failed for collection',
            collection,
            ':',
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    }

    const usedKeywordFallback = !outcome.ok || allResults.length === 0;
    if (usedKeywordFallback) {
      if (!outcome.ok) {
        console.error(`[INFO] embedding.fallback path=keyword provider=none scope=document-index`);
      }

      for (const collection of this.collections) {
        try {
          const filters = buildCollectionFilters(collection, query);
          if (filters.skip) {
            continue;
          }

          const results = await this.vectorStore.searchKeyword(collection, query.text, {
            limit: perCollection,
            ...(Object.keys(filters.filters).length > 0 ? { filters: filters.filters } : {}),
          });
          allResults.push(...results);
        } catch (error) {
          console.error(
            '[WARN] Document index keyword search failed for collection',
            collection,
            ':',
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    }

    const sorted = allResults
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
          searchMethod: usedKeywordFallback ? ('keyword' as const) : ('vector' as const),
          ...(outcome.ok ? { embeddingProvider: outcome.result.provider } : { embeddingError: outcome.error }),
        },
      }));

    return sorted;
  }
}

function buildCollectionFilters(
  collection: string,
  query: RagQuery,
): { skip: boolean; filters: Record<string, unknown> } {
  if (collection !== 'knowledge_base') {
    return { skip: false, filters: {} };
  }

  const hasActorScope = typeof query.actorId === 'string' && query.actorId.length > 0;
  const hasConversationScope = typeof query.conversationId === 'string' && query.conversationId.length > 0;

  if (!hasActorScope && !hasConversationScope) {
    console.error(
      '[WARN] Skipping unscoped knowledge_base search (collection=knowledge_base). ' +
        'knowledge_base retrieval requires actor_id or conversation_id scope.',
    );
    return { skip: true, filters: {} };
  }

  const filters: Record<string, unknown> = {};
  if (query.actorId) {
    filters.actor_id = query.actorId;
  }
  if (query.conversationId) {
    filters.conversation_id = query.conversationId;
  }
  return { skip: false, filters };
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
