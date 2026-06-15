import type { EmbeddingClient } from './embeddings.js';
import type { VectorStore, VectorRecord } from './vector/index.js';

export interface AddKnowledgeInput {
  title: string;
  content: string;
  source?: string;
  actorId?: string;
  conversationId?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  createdBy?: string;
}

export interface KnowledgeRecord {
  id: string;
  title: string;
  content: string;
  source: string;
  actorId?: string;
  conversationId?: string;
  tags: string[];
  metadata: Record<string, unknown>;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeStore {
  add(input: AddKnowledgeInput): Promise<KnowledgeRecord>;
  list(filters?: ListKnowledgeFilters): Promise<KnowledgeRecord[]>;
  remove(id: string): Promise<boolean>;
}

export interface ListKnowledgeFilters {
  actorId?: string;
  conversationId?: string;
  tags?: string[];
  source?: string;
}

export interface LanceDbKnowledgeStoreOptions {
  vectorStore: VectorStore;
  embeddingClient: EmbeddingClient;
}

const knowledgeCollection = 'knowledge_base';

export class LanceDbKnowledgeStore implements KnowledgeStore {
  private readonly vectorStore: VectorStore;
  private readonly embeddingClient: EmbeddingClient;

  constructor(options: LanceDbKnowledgeStoreOptions) {
    this.vectorStore = options.vectorStore;
    this.embeddingClient = options.embeddingClient;
  }

  async add(input: AddKnowledgeInput): Promise<KnowledgeRecord> {
    const record = createKnowledgeRecord(input);
    const vector = await this.embeddingClient.embed(record.content);
    const vectorRecord: VectorRecord = {
      id: record.id,
      chunk_key: record.id,
      source: 'agent_knowledge',
      title: record.title,
      content: record.content,
      vector,
      actor_id: record.actorId,
      conversation_id: record.conversationId,
      metadata: {
        ...record.metadata,
        tags: record.tags,
        source: record.source,
        createdBy: record.createdBy,
      },
      updated_at: record.updatedAt,
    };

    await this.vectorStore.upsert(knowledgeCollection, [vectorRecord]);
    return record;
  }

  async list(filters: ListKnowledgeFilters = {}): Promise<KnowledgeRecord[]> {
    const queryFilters: Record<string, unknown> = {};
    if (filters.actorId) {
      queryFilters.actor_id = filters.actorId;
    }
    if (filters.conversationId) {
      queryFilters.conversation_id = filters.conversationId;
    }
    if (filters.source) {
      queryFilters.source = filters.source;
    }

    const dummyVector = new Array(768).fill(0);
    const vectorLimit = filters.tags && filters.tags.length > 0 ? 10_000 : 1_000;
    const results = await this.vectorStore.search(knowledgeCollection, dummyVector, {
      limit: vectorLimit,
      filters: queryFilters,
    });

    return results
      .map((result) => toKnowledgeRecord(result))
      .filter((record) => matchesFilters(record, filters));
  }

  async remove(id: string): Promise<boolean> {
    await this.vectorStore.delete(knowledgeCollection, [id]);
    return true;
  }
}

function createKnowledgeRecord(input: AddKnowledgeInput): KnowledgeRecord {
  const now = new Date().toISOString();
  return {
    id: createKnowledgeId(input.title, input.content, now),
    title: input.title.trim(),
    content: input.content.trim(),
    source: input.source ?? 'agent',
    ...(input.actorId ? { actorId: input.actorId } : {}),
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    tags: input.tags ?? [],
    metadata: input.metadata ?? {},
    ...(input.createdBy ? { createdBy: input.createdBy } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

function createKnowledgeId(title: string, content: string, timestamp: string): string {
  const encoder = new TextEncoder();
  const data = encoder.encode(`${title}\0${content}\0${timestamp}`);
  let hash = 0;

  for (let index = 0; index < data.length; index += 1) {
    const byte = data[index];
    hash = (hash << 5) - hash + byte;
    hash |= 0;
  }

  return `kb-${Math.abs(hash).toString(16)}`;
}

function toKnowledgeRecord(result: { id: string; title: string; content: string; metadata?: Record<string, unknown>; updated_at: string }): KnowledgeRecord {
  const metadata = result.metadata ?? {};
  return {
    id: result.id,
    title: result.title,
    content: result.content,
    source: String(metadata.source ?? 'agent'),
    ...(typeof metadata.actor_id === 'string' ? { actorId: metadata.actor_id } : {}),
    ...(typeof metadata.conversation_id === 'string' ? { conversationId: metadata.conversation_id } : {}),
    tags: Array.isArray(metadata.tags) ? metadata.tags.filter((item): item is string => typeof item === 'string') : [],
    metadata: { ...metadata, source: undefined, tags: undefined, createdBy: undefined },
    ...(typeof metadata.createdBy === 'string' ? { createdBy: metadata.createdBy } : {}),
    createdAt: result.updated_at,
    updatedAt: result.updated_at,
  };
}

function matchesFilters(record: KnowledgeRecord, filters: ListKnowledgeFilters): boolean {
  if (filters.actorId && record.actorId !== filters.actorId) {
    return false;
  }
  if (filters.conversationId && record.conversationId !== filters.conversationId) {
    return false;
  }
  if (filters.source && record.source !== filters.source) {
    return false;
  }
  if (filters.tags && filters.tags.length > 0) {
    const recordTags = new Set(record.tags);
    if (!filters.tags.every((tag) => recordTags.has(tag))) {
      return false;
    }
  }
  return true;
}
