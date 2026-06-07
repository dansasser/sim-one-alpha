import type { RagQuery, RetrievedContext } from '../types/index.js';

export interface MemoryProvider {
  retrieve(query: RagQuery): Promise<RetrievedContext[]>;
}

export class DatabaseMemoryProviderPlaceholder implements MemoryProvider {
  constructor(readonly connectionName: string) {}

  async retrieve(query: RagQuery): Promise<RetrievedContext[]> {
    if (!query.text.trim()) {
      return [];
    }

    return [
      {
        id: `memory:${query.conversationId}`,
        provider: 'memory',
        title: 'Conversation memory placeholder',
        content: 'Database-backed memory retrieval placeholder. Storage behavior will be expanded later.',
        score: 0.25,
        metadata: {
          connectionName: this.connectionName,
          actorId: query.actorId,
        },
      },
    ];
  }
}

