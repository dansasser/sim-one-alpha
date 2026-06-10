import type { RagQuery, RetrievedContext } from '../types/index.js';
import { goromboPersistenceRuntime } from '../db.js';

export interface MemoryProvider {
  retrieve(query: RagQuery): Promise<RetrievedContext[]>;
}

export class SessionMemoryProvider implements MemoryProvider {
  constructor(readonly connectionName = 'session-memory') {}

  async retrieve(query: RagQuery): Promise<RetrievedContext[]> {
    if (!query.text.trim()) {
      return [];
    }

    return goromboPersistenceRuntime.sessionDatabase
      .searchSessionMemory({
        text: query.text,
        limit: query.limit,
      })
      .map((record) => ({
        id: `memory:${record.id}`,
        provider: 'memory',
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
        },
      }));
  }
}
