import type { RagQuery, RetrievedContext } from '../types/index.js';
import type { MemoryEngine } from './memory-engine.js';
import type { MemoryProvider } from './memory-provider.js';

/**
 * Structured-memory provider for the Memory Helper.
 *
 * Phase 0 ships the skeleton only. Phase 2 fills in:
 *   - SQLite-backed `GoromboStructuredMemoryDatabase` for cold reads
 *   - `engine.query` for keyword/tag ranking
 *   - LanceDB vector search for `session_note` semantic matching
 *   - Reciprocal rank fusion merging keyword + vector results
 *   - Token-budget truncation via `estimateTextTokens`
 *   - Scope isolation enforced at the SQL filter and Rust `matches` layer
 *
 * Until Phase 2 lands, `retrieve` returns `[]` so the existing tool
 * contract is preserved without surfacing fake data.
 */
export interface ChecklistMemoryProviderOptions {
  engine: MemoryEngine;
  maxContextTokens?: number;
  defaultLimit?: number;
}

export class ChecklistMemoryProvider implements MemoryProvider {
  private readonly engine: MemoryEngine;
  private readonly maxContextTokens: number;
  private readonly defaultLimit: number;

  constructor(options: ChecklistMemoryProviderOptions) {
    this.engine = options.engine;
    this.maxContextTokens = options.maxContextTokens ?? 1500;
    this.defaultLimit = options.defaultLimit ?? 10;
  }

  async retrieve(_query: RagQuery): Promise<RetrievedContext[]> {
    return [];
  }
}
