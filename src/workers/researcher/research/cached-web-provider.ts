import type { RagProvider, WebFetchResult } from '../../../rag/providers.js';
import type { RagQuery, RetrievedContext } from '../../../types/index.js';
import {
  type ResearchRunCache,
  createExpiresAt,
  createSearchCacheKey,
} from './research-cache.js';

export interface CachedWebSearchProviderOptions {
  cache: ResearchRunCache;
  searchTtlMs: number;
  pageTtlMs: number;
  bypassCacheReads?: boolean;
  now?: Date;
}

export class CachedWebSearchProvider implements RagProvider {
  readonly id = 'web-search';
  readonly name: string;

  constructor(
    private readonly provider: RagProvider,
    private readonly options: CachedWebSearchProviderOptions,
  ) {
    this.name = provider.name ? `cached-${provider.name}` : 'cached-web';
  }

  async retrieve(query: RagQuery): Promise<RetrievedContext[]> {
    const limit = query.limit ?? 5;
    const key = createSearchCacheKey({
      query: query.text,
      provider: this.provider.name ?? this.provider.id,
      limit,
    });
    const now = this.options.now ?? new Date();
    const cached = this.options.bypassCacheReads ? null : await this.options.cache.getSearch(key, now);

    if (cached) {
      return cached.contexts.map((context) => ({
        ...context,
        metadata: {
          ...context.metadata,
          cache: 'hit',
          cacheKey: key,
        },
      }));
    }

    const contexts = await this.provider.retrieve(query);
    await this.options.cache.setSearch({
      key,
      query: query.text,
      provider: this.provider.name ?? this.provider.id,
      limit,
      contexts,
      retrievedAt: now.toISOString(),
      expiresAt: createExpiresAt(this.options.searchTtlMs, now),
    });

    return contexts.map((context) => ({
      ...context,
      metadata: {
        ...context.metadata,
        cache: 'miss',
        cacheKey: key,
      },
    }));
  }

  async fetchPage(url: string): Promise<WebFetchResult> {
    const provider = this.provider as Partial<{ fetchPage(url: string): Promise<WebFetchResult> }>;
    if (typeof provider.fetchPage !== 'function') {
      throw new Error('Configured web search provider does not support page fetch.');
    }

    const now = this.options.now ?? new Date();
    const cached = this.options.bypassCacheReads ? null : await this.options.cache.getPage(url, now);
    if (cached) {
      return {
        ...cached.page,
        provider: `${cached.page.provider}:cache`,
      };
    }

    const page = await provider.fetchPage(url);
    await this.options.cache.setPage({
      url,
      page,
      retrievedAt: now.toISOString(),
      expiresAt: createExpiresAt(this.options.pageTtlMs, now),
    });

    return page;
  }
}
