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
    const providerFailures: NonNullable<RagResult['metadata']>['providerFailures'] = [];
    const enabled = new Set(query.providers ?? ['memory', 'web-search', 'document-index']);

    if (enabled.has('memory')) {
      try {
        contexts.push(...(await this.memoryRouter.retrieve(query)));
      } catch (error) {
        providerFailures.push({
          provider: 'memory',
          name: 'memory',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    for (const provider of this.providers) {
      if (enabled.has(provider.id)) {
        try {
          contexts.push(...(await provider.retrieve(query)));
        } catch (error) {
          providerFailures.push({
            provider: provider.id,
            name: provider.name,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    const limited = contexts
      .sort((left, right) => right.score - left.score)
      .slice(0, readLimit(query.limit));

    return {
      query,
      retrievedAt: new Date().toISOString(),
      contexts: limited,
      metadata: providerFailures.length
        ? {
            providerFailures,
          }
        : undefined,
    };
  }
}

function readLimit(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 5;
}
