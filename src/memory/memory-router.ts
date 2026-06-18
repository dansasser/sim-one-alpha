import type { RagProviderKind, RagQuery, RetrievedContext } from '../types/index.js';
import type { MemoryProvider } from './memory-provider.js';

/**
 * Multi-provider memory router.
 *
 * Fans `retrieve` out to every registered provider whose kind is in
 * `query.providers` (or all registered providers when `providers` is unset),
 * applies a per-provider limit, and merges the resulting `RetrievedContext`
 * lists with reciprocal rank fusion (RRF). The structured-memory provider is
 * registered under the `'structured-memory'` `RagProviderKind` (Decision 10);
 * session memory stays under `'memory'`.
 */
export class MemoryRouter {
  private readonly providers: Map<RagProviderKind, MemoryProvider>;

  constructor(providers: Map<RagProviderKind, MemoryProvider> = new Map()) {
    this.providers = providers;
  }

  /** Build a router from a single provider (kept for test/legacy callers). */
  static fromSingle(kind: RagProviderKind, provider: MemoryProvider): MemoryRouter {
    return new MemoryRouter(new Map([[kind, provider]]));
  }

  retrieve(query: RagQuery): Promise<RetrievedContext[]> {
    const enabled = query.providers?.length
      ? new Set<RagProviderKind>(query.providers)
      : new Set<RagProviderKind>(this.providers.keys());
    const lists: Promise<RetrievedContext[]>[] = [];
    for (const [kind, provider] of this.providers) {
      if (enabled.has(kind)) {
        lists.push(provider.retrieve(query).catch((error) => {
          console.error(
            `[WARN] memory provider ${kind} failed:`,
            error instanceof Error ? error.message : String(error),
          );
          return [] as RetrievedContext[];
        }));
      }
    }
    return Promise.all(lists).then((results) => reciprocalRankFusion(results));
  }
}

const RRF_K = 60;

/** Reciprocal rank fusion across multiple ranked lists. */
export function reciprocalRankFusion(lists: RetrievedContext[][]): RetrievedContext[] {
  const scores = new Map<string, { context: RetrievedContext; score: number }>();
  for (const list of lists) {
    for (let index = 0; index < list.length; index += 1) {
      const context = list[index];
      const key = `${context.provider}\0${context.id}\0${context.title}\0${context.content}`;
      const rrfScore = 1 / (RRF_K + index + 1);
      const existing = scores.get(key);
      if (existing) {
        existing.score += rrfScore;
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
    .map((item) => ({ ...item.context, score: item.score }));
}
