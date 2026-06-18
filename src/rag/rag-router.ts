import type { RagQuery, RagResult, RagResultMetadata, RetrievedContext } from '../types/index.js';
import type { MemoryRouter } from '../memory/memory-router.js';
import type { RagProvider } from './providers.js';

export class RagRouter {
  constructor(
    private readonly memoryRouter: MemoryRouter,
    private readonly providers: RagProvider[],
  ) {}

  async retrieve(query: RagQuery): Promise<RagResult> {
    const contexts: RetrievedContext[] = [];
    const providerFailures: RagResultMetadata['providerFailures'] = [];
    const enabled = new Set(query.providers ?? ['memory', 'web-search', 'document-index']);

    if (enabled.has('memory')) {
      try {
        contexts.push(...(await this.memoryRouter.retrieve(query)));
      } catch (error) {
        providerFailures?.push({
          provider: 'memory',
          name: 'memory',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    for (const provider of this.providers) {
      if (enabled.has(provider.id)) {
        try {
          const providerContexts = await provider.retrieve(query);
          contexts.push(...providerContexts);
        } catch (error) {
          providerFailures?.push({
            provider: provider.id,
            name: provider.name,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    promoteEmbeddingErrors(contexts, providerFailures);

    const limited = contexts
      .sort((left, right) => right.score - left.score)
      .slice(0, readLimit(query.limit));

    return {
      query,
      retrievedAt: new Date().toISOString(),
      contexts: limited,
      metadata: providerFailures?.length
        ? {
            providerFailures,
          }
        : undefined,
    };
  }
}

function promoteEmbeddingErrors(
  contexts: RetrievedContext[],
  providerFailures: RagResultMetadata['providerFailures'],
): void {
  if (!providerFailures) {
    return;
  }

  const seen = new Set(providerFailures.map((failure) => failure.message));

  for (const context of contexts) {
    const error = context.metadata?.embeddingError;
    if (typeof error === 'string' && !seen.has(error)) {
      seen.add(error);
      providerFailures.push({
        provider: 'document-index',
        name: context.metadata?.collection?.toString() ?? 'document-index',
        message: error,
      });
    }
  }
}

function readLimit(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 5;
}
