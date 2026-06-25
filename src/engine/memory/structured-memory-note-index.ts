import type { EmbeddingClient } from '../../engine/rag/embeddings.js';
import type { VectorStore, VectorSearchResult } from '../../engine/rag/vector/lance-db-store.js';
import type { RetrievedContext } from '../../core/types/index.js';
import type { MemoryRecordScope, SessionNote } from '../../core/types/memory.js';

export const STRUCTURED_MEMORY_NOTES_COLLECTION = 'structured_memory_notes';

export interface StructuredMemoryNoteIndexOptions {
  vectorStore?: VectorStore;
  embeddingClient?: EmbeddingClient;
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

  constructor(options: StructuredMemoryNoteIndexOptions = {}) {
    this.vectorStore = options.vectorStore;
    this.embeddingClient = options.embeddingClient;
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
          actor_id: note.scope.actorId ?? '',
          conversation_id: note.scope.conversationId ?? '',
          thread_id: note.scope.threadId ?? '',
          metadata: {
            kind: 'session_note',
            recordId: note.id,
            projectId: note.scope.projectId,
            actorId: note.scope.actorId,
            conversationId: note.scope.conversationId,
            threadId: note.scope.threadId,
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

  /** Prune vector rows whose note ids are not in `activeIds` (orphans after cleanup). */
  async pruneStaleNoteVectors(activeIds: Set<string>): Promise<void> {
    if (!this.vectorStore) {
      return;
    }
    try {
      const ids = await this.vectorStore.listIds(STRUCTURED_MEMORY_NOTES_COLLECTION);
      const orphans = ids.filter((id) => !activeIds.has(id));
      for (const id of orphans) {
        await this.deleteNote(id);
      }
    } catch (error) {
      console.error(
        '[WARN] structured-memory note vector prune failed:',
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

/** Post-filter vector results by the FULL scope in TS. LanceDB nested-metadata
 * WHERE filters are unreliable, so scope isolation is enforced here
 * unconditionally. The query scope must match every key the record carries -
 * a note scoped to a different actor/conversation/project never leaks. */
function scopeMatchesResult(result: VectorSearchResult, scope: MemoryRecordScope): boolean {
  const meta = result.metadata ?? {};
  const metaProjectId = typeof meta.projectId === 'string' ? meta.projectId : undefined;
  const metaActorId = typeof meta.actorId === 'string' ? meta.actorId : undefined;
  const metaConversationId = typeof meta.conversationId === 'string' ? meta.conversationId : undefined;
  const metaThreadId = typeof meta.threadId === 'string' ? meta.threadId : undefined;
  // If the record carries a key the query does not (or differs), reject.
  if (metaProjectId !== undefined && metaProjectId !== scope.projectId) return false;
  if (metaActorId !== undefined && metaActorId !== scope.actorId) return false;
  if (metaConversationId !== undefined && metaConversationId !== scope.conversationId) return false;
  if (metaThreadId !== undefined && metaThreadId !== scope.threadId) return false;
  // If the query carries a key the record does not have, reject (the query is
  // asking for a specific scope the note is not part of).
  if (scope.projectId && metaProjectId === undefined) return false;
  if (scope.actorId && metaActorId === undefined) return false;
  if (scope.conversationId && metaConversationId === undefined) return false;
  if (scope.threadId && metaThreadId === undefined) return false;
  return true;
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
