import type { RagQuery, RetrievedContext } from '../types/index.js';

export interface RagProvider {
  readonly id: string;
  retrieve(query: RagQuery): Promise<RetrievedContext[]>;
}

export class WebSearchProviderPlaceholder implements RagProvider {
  readonly id = 'web-search';

  async retrieve(query: RagQuery): Promise<RetrievedContext[]> {
    if (!query.text.trim()) {
      return [];
    }

    return [
      {
        id: `web:${query.eventId}`,
        provider: 'web-search',
        title: 'Web search placeholder',
        content: 'Web search provider is wired into the RAG router but does not call external search yet.',
        score: 0.1,
      },
    ];
  }
}

export class DocumentIndexProviderPlaceholder implements RagProvider {
  readonly id = 'document-index';

  async retrieve(query: RagQuery): Promise<RetrievedContext[]> {
    if (!query.text.trim()) {
      return [];
    }

    return [
      {
        id: `doc-index:${query.eventId}`,
        provider: 'document-index',
        title: 'Document index placeholder',
        content: 'Placeholder for the existing doc-index concept from OpenClaw-style retrieval.',
        score: 0.2,
        metadata: {
          concept: 'doc-index',
        },
      },
    ];
  }
}

