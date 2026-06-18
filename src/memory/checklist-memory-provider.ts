import type { MemoryEngine } from './memory-engine.js';
import type { MemoryProvider } from './memory-provider.js';
import type { RagQuery, RetrievedContext } from '../types/index.js';

/**
 * Options for the structured-memory RAG provider.
 *
 * `maxContextTokens` and `defaultLimit` bound how much structured memory is
 * injected into a single prompt. Defaults land in Phase 2 alongside the real
 * `retrieve` implementation and config wiring.
 */
export interface ChecklistMemoryProviderOptions {
  engine: MemoryEngine;
  maxContextTokens?: number;
  defaultLimit?: number;
}

/**
 * Structured-memory RAG provider.
 *
 * Surfaces checklists, todos, and session notes as `RetrievedContext` records
 * alongside session-memory chunks through the `MemoryRouter` (Phase 2). The
 * record's own `kind` field on each record's metadata tells the consumer what
 * it is (Decision 10). The new `RagProviderKind` value `'structured-memory'`
 * is added in Phase 2.
 *
 * Phase 0: stub implementation. Returns no records. Full ranking, token
 * truncation, and scope isolation land in Phase 2.
 */
export class ChecklistMemoryProvider implements MemoryProvider {
  private readonly engine: MemoryEngine;
  private readonly maxContextTokens: number | undefined;
  private readonly defaultLimit: number | undefined;

  constructor(options: ChecklistMemoryProviderOptions) {
    this.engine = options.engine;
    this.maxContextTokens = options.maxContextTokens;
    this.defaultLimit = options.defaultLimit;
  }

  /** Available for Phase 2 wiring. */
  get maxContextTokensConfig(): number | undefined {
    return this.maxContextTokens;
  }

  /** Available for Phase 2 wiring. */
  get defaultLimitConfig(): number | undefined {
    return this.defaultLimit;
  }

  /** Available for Phase 2 wiring. */
  protected get memoryEngine(): MemoryEngine {
    return this.engine;
  }

  async retrieve(_query: RagQuery): Promise<RetrievedContext[]> {
    // Phase 0 stub: no structured records are surfaced yet.
    return [];
  }
}
