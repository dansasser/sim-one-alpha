import type { EmbeddingClient } from '../rag/embeddings.js';
import type { VectorStore, VectorSearchResult } from '../rag/vector/lance-db-store.js';
import type { RetrievedContext } from '../types/index.js';
import type { MemoryRecordScope, SessionNote } from '../types/memory.js';

export const STRUCTURED_MEMORY_NOTES_COLLECTION = 'structured_memory_notes';

export interface StructuredMemoryNoteIndexOptions {
  vectorStore?: VectorStore;
  embeddingClient?: EmbeddingClient;
  /** Filter vector results by projectId when the query scope carries one. */
  scopeFilters?: boolean;
}

export interface NoteSearchQuery {
  text: string;
  scope: MemoryRecordScope;
  limit?: number;
}

/**
 * LanceDB-backed semantic index over session-note content. Embeds
 * `title + content` on upsert, deletes on archive, and supports semantic
 * search merged with the engine's keyword index via reciprocal rank fusion
 * (Decision 5). Falls back gracefully (returns []) when no embedding client
 * or vector store is configured, or when the vector search throws.
 */
export class StructuredMemoryNoteIndex {
  private readonly vectorStore?: VectorStore;
  private readonly embeddingClient?: EmbeddingClient;
  private readonly scopeFilters: boolean;

  constructor(options: StructuredMemoryNoteIndexOptions = {}) {
    this.vectorStore = options.vectorStore;
    this.embeddingClient = options.embeddingClient;
    this.scopeFilters = options.scopeFilters ?? true;
  }

  get available(): boolean {
    return Boolean(this.vectorStore && this.embeddingClient);
  }

  async upsertNote(note: SessionNote): Promise<void> {
    if (!this.available) {
      return;
    }
    try {
      const vector = await this.embeddingClient!.embed(`${note.title}\n${note.content}`);
      await this.vectorStore!.upsert(STRUCTURED_MEMORY_NOTES_COLLECTION, [
        {
          id: note.id,
          source: 'structured-memory',
          title: note.title,
          content: note.content,
          vector,
          actor_id: note.scope.actorId,
          conversation_id: note.scope.conversationId,
          thread_id: note.scope.threadId,
          metadata: {
            kind: 'session_note',
            recordId: note.id,
            projectId: note.scope.projectId,
            importance: note.importance,
            status: note.status,
            tagsCsv: note.tags.join(','),
          },
          updated_at: note.updatedAt,
        },
      ]);
    } catch (error) {
      console.error(
        '[WARN] structured-memory note vector upsert failed:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async deleteNote(id: string): Promise<void> {
    if (!this.vectorStore) {
      return;
    }
    try {
      await this.vectorStore.delete(STRUCTURED_MEMORY_NOTES_COLLECTION, [id]);
    } catch (error) {
      console.error(
        '[WARN] structured-memory note vector delete failed:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /** Semantic search over session notes. Returns [] when unavailable or on error. */
  async search(query: NoteSearchQuery): Promise<RetrievedContext[]> {
    if (!this.available || !query.text.trim()) {
      return [];
    }
    try {
      const vector = await this.embeddingClient!.embed(query.text);
      // Over-fetch so post-filtering by scope still yields enough results.
      const fetchLimit = Math.max(query.limit ?? 10, 20) * 2;
      const results = await this.vectorStore!.search(STRUCTURED_MEMORY_NOTES_COLLECTION, vector, {
        limit: fetchLimit,
      });
      return results
        .filter((result) => result.metadata?.kind === 'session_note')
        .filter((result) => scopeMatchesResult(result, query.scope))
        .map((result) => toRetrievedContext(result))
        .slice(0, query.limit ?? 10);
    } catch (error) {
      console.error(
        '[WARN] structured-memory note vector search failed:',
        error instanceof Error ? error.message : String(error),
      );
      return [];
    }
  }
}

/** Post-filter vector results by project scope in TS (LanceDB nested-metadata filters are
 * unreliable). The keyword path already enforces the full scope via the engine;
 * the vector path is a best-effort semantic augmentation scoped by projectId. */
function scopeMatchesResult(result: VectorSearchResult, scope: MemoryRecordScope): boolean {
  if (!scope.projectId) {
    return true;
  }
  const metaProjectId = typeof result.metadata?.projectId === 'string' ? result.metadata.projectId : undefined;
  return metaProjectId === scope.projectId;
}

function toRetrievedContext(result: VectorSearchResult): RetrievedContext {
  return {
    id: `structured-memory:${result.id}`,
    provider: 'structured-memory',
    title: result.title,
    content: result.content,
    score: result.score,
    metadata: {
      ...(result.metadata ?? {}),
      kind: 'session_note',
      recordId: result.id,
      searchMethod: 'vector',
    },
  };
}
