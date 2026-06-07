import type { RagQuery, RagResult, RetrievedContext } from '../types/index.js';
import type { MemoryRouter } from '../memory/memory-router.js';
import type { RagProvider } from './providers.js';

export class RagRouter {
  constructor(
    private readonly memoryRouter: MemoryRouter,
    private readonly providers: RagProvider[],
  ) {}

  async retrieve(query: RagQuery): Promise<RagResult> {
    const contexts: RetrievedContext[] = [];
    const enabled = new Set(query.providers ?? ['memory', 'web-search', 'document-index']);

    if (enabled.has('memory')) {
      contexts.push(...(await this.memoryRouter.retrieve(query)));
    }

    for (const provider of this.providers) {
      if (enabled.has(provider.id as never)) {
        contexts.push(...(await provider.retrieve(query)));
      }
    }

    const limited = contexts
      .sort((left, right) => right.score - left.score)
      .slice(0, query.limit ?? 5);

    return {
      query,
      retrievedAt: new Date().toISOString(),
      contexts: limited,
    };
  }
}

