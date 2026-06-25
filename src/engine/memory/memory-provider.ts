import type { EmbeddingClient } from '../../engine/rag/embeddings.js';
import type { VectorStore } from '../../engine/rag/vector/index.js';
import { goromboPersistenceRuntime } from '../../core/db.js';
import type { RagQuery, RetrievedContext } from '../../core/types/index.js';

export interface MemoryProvider {
  retrieve(query: RagQuery): Promise<RetrievedContext[]>;
}

export interface SessionMemoryProviderOptions {
  connectionName?: string;
  vectorStore?: VectorStore;
  embeddingClient?: EmbeddingClient;
}

export class SessionMemoryProvider implements MemoryProvider {
  readonly connectionName: string;
  private readonly vectorStore?: VectorStore;
  private readonly embeddingClient?: EmbeddingClient;

  constructor(options: SessionMemoryProviderOptions = {}) {
    this.connectionName = options.connectionName ?? 'session-memory';
    this.vectorStore = options.vectorStore;
    this.embeddingClient = options.embeddingClient;
  }

  async retrieve(query: RagQuery): Promise<RetrievedContext[]> {
    if (!query.text.trim()) {
      return [];
    }

    const ftsResults = this.searchFts(query);
    const vectorResults = await this.searchVector(query);
    const merged = reciprocalRankFusion([ftsResults, vectorResults]);

    return merged.slice(0, readLimit(query.limit));
  }

  private searchFts(query: RagQuery): RetrievedContext[] {
    return goromboPersistenceRuntime.sessionDatabase
      .searchSessionMemory({
        text: query.text,
        limit: readLimit(query.limit),
        actorId: query.actorId,
        conversationId: query.conversationId,
        sessionId: query.sessionId,
      })
      .map((record) => ({
        id: `memory:${record.id}`,
        provider: 'memory' as const,
        title: record.title,
        content: record.content,
        score: record.score,
        metadata: {
          ...record.metadata,
          connectionName: this.connectionName,
          actorId: query.actorId,
          conversationId: query.conversationId,
          sourceSession: record.sessionName,
          sourceHarness: record.harnessName,
          sourceEntryId: record.entryId,
          tokenEstimate: record.tokenEstimate,
          searchMethod: 'fts',
        },
      }));
  }

  private async searchVector(query: RagQuery): Promise<RetrievedContext[]> {
    if (!this.vectorStore || !this.embeddingClient) {
      return [];
    }

    try {
      const vector = await this.embeddingClient.embed(query.text);
      const results = await this.vectorStore.search('session_memory', vector, {
        limit: readLimit(query.limit),
        filters: createVectorFilters(query),
      });

      return results.map((result) => ({
        id: `memory:${result.id}`,
        provider: 'memory' as const,
        title: result.title,
        content: result.content,
        score: result.score,
        metadata: {
          ...result.metadata,
          connectionName: this.connectionName,
          actorId: query.actorId,
          conversationId: query.conversationId,
          sourceSession: result.metadata?.sessionName,
          sourceHarness: result.metadata?.harnessName,
          sourceEntryId: result.metadata?.entryId,
          searchMethod: 'vector',
        },
      }));
    } catch (error) {
      // Vector search is a best-effort augmentation. Log and fall back to FTS.
      console.error('[WARN] Session memory vector search failed:', error instanceof Error ? error.message : String(error));
      return [];
    }
  }
}

function createVectorFilters(query: RagQuery): Record<string, unknown> {
  const filters: Record<string, unknown> = {};

  if (query.sessionId) {
    filters.session_name = query.sessionId;
  }

  if (query.actorId) {
    filters.actor_id = query.actorId;
  }

  if (query.conversationId) {
    filters.conversation_id = query.conversationId;
  }

  return filters;
}

const rrfK = 60;

function reciprocalRankFusion(lists: RetrievedContext[][]): RetrievedContext[] {
  const scores = new Map<string, { context: RetrievedContext; score: number }>();

  for (const list of lists) {
    for (let index = 0; index < list.length; index += 1) {
      const context = list[index];
      const key = `${context.title}\0${context.content}`;
      const existing = scores.get(key);
      const rrfScore = 1 / (rrfK + index + 1);

      if (existing) {
        existing.score += rrfScore;
        // Keep the highest original score in metadata.
        if (context.score > existing.context.score) {
          existing.context = context;
        }
      } else {
        scores.set(key, { context, score: rrfScore });
      }
    }
  }

  return [...scores.values()]
    .sort((left, right) => right.score - left.score)
    .map((item) => ({
      ...item.context,
      score: item.score,
    }));
}

function readLimit(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 5;
}
