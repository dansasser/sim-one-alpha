import type { RagQuery, RetrievedContext } from '../types/index.js';

export interface RagProvider {
  readonly id: string;
  readonly name?: string;
  retrieve(query: RagQuery): Promise<RetrievedContext[]>;
}

export interface WebFetchResult {
  title: string;
  url: string;
  content: string;
  links: string[];
  provider: string;
  retrievedAt: string;
}

export interface OllamaWebSearchProviderOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class WebSearchProviderPlaceholder implements RagProvider {
  readonly id = 'web-search';
  readonly name = 'placeholder';

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

export class OllamaWebSearchProvider implements RagProvider {
  readonly id = 'web-search';
  readonly name = 'ollama';

  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OllamaWebSearchProviderOptions) {
    this.baseUrl = options.baseUrl ?? 'https://ollama.com';
    this.fetchImpl = options.fetch ?? fetch;
  }

  async retrieve(query: RagQuery): Promise<RetrievedContext[]> {
    if (!query.text.trim()) {
      return [];
    }

    const response = await this.postJson('/api/web_search', {
      query: query.text,
      max_results: clampMaxResults(query.limit ?? 5),
    });
    const body = (await response.json()) as { results?: unknown };
    const results = Array.isArray(body.results) ? body.results : [];

    return results.flatMap((result, index): RetrievedContext[] => {
      if (!result || typeof result !== 'object') {
        return [];
      }

      const item = result as { title?: unknown; url?: unknown; content?: unknown };
      const title = readString(item.title);
      const url = readString(item.url);
      const content = readString(item.content);
      if (!title || !url || !content) {
        return [];
      }

      return [
        {
          id: `ollama-web:${query.eventId}:${index}`,
          provider: 'web-search',
          title,
          content,
          score: Math.max(0.1, 0.8 - index * 0.05),
          metadata: {
            provider: 'ollama',
            url,
          },
        },
      ];
    });
  }

  async fetchPage(url: string): Promise<WebFetchResult> {
    const response = await this.postJson('/api/web_fetch', { url });
    const body = (await response.json()) as {
      title?: unknown;
      content?: unknown;
      links?: unknown;
    };

    return {
      title: readString(body.title) ?? url,
      url,
      content: readString(body.content) ?? '',
      links: Array.isArray(body.links) ? body.links.flatMap((link) => (typeof link === 'string' ? [link] : [])) : [],
      provider: 'ollama',
      retrievedAt: new Date().toISOString(),
    };
  }

  private async postJson(path: string, body: Record<string, unknown>): Promise<Response> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Ollama web search request failed with status ${response.status}.`);
    }

    return response;
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

export function createDefaultWebSearchProvider(env: Record<string, unknown>): RagProvider {
  const provider = readString(env.GOROMBO_WEB_SEARCH_PROVIDER) ?? 'ollama';
  const ollamaKey = readString(env.OLLAMA_API_KEY) ?? readString(env.OLLAMA_CLOUD_API_KEY);

  if (provider === 'ollama' && ollamaKey) {
    return new OllamaWebSearchProvider({
      apiKey: ollamaKey,
      baseUrl: readString(env.OLLAMA_WEB_SEARCH_BASE_URL) ?? 'https://ollama.com',
    });
  }

  return new WebSearchProviderPlaceholder();
}

function clampMaxResults(value: number): number {
  return Math.max(1, Math.min(10, Math.floor(value)));
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
