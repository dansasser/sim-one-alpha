import { estimateTextTokens } from '../session/context-budget.js';
import { reciprocalRankFusion } from './memory-router.js';
import type { StructuredMemoryNoteIndex } from './structured-memory-note-index.js';
import type { RagQuery, RetrievedContext } from '../types/index.js';
import type { MemoryRecord, MemoryRecordScope, QueryInput } from '../types/memory.js';
import type { MemoryEngine } from './memory-engine.js';
import type { MemoryProvider } from './memory-provider.js';

/**
 * Options for the structured-memory RAG provider.
 *
 * `engineLoader` lazily resolves the `MemoryEngine` (the WASM engine loads
 * asynchronously). The provider is constructed synchronously and loads the
 * engine on first `retrieve`, so module-load order never blocks on the WASM
 * artifact.
 */
export interface ChecklistMemoryProviderOptions {
  engineLoader: () => Promise<MemoryEngine>;
  maxContextTokens?: number;
  defaultLimit?: number;
  /** Optional LanceDB note index for semantic session-note search (Decision 5). */
  noteIndex?: StructuredMemoryNoteIndex;
}

/**
 * Structured-memory RAG provider.
 *
 * Surfaces checklists, todos, and session notes as `RetrievedContext` records
 * (provider `'structured-memory'`) alongside session-memory chunks through
 * the multi-provider `MemoryRouter`. The record's own `kind` field on each
 * record's metadata tells the consumer what it is (Decision 10).
 *
 * Scope is derived from the trusted `RagQuery` (actorId/conversationId/
 * projectId/threadId), never from the model. The engine enforces scope
 * isolation; this provider only translates the query and truncates the result
 * to the caller's context budget.
 */
export class ChecklistMemoryProvider implements MemoryProvider {
  private readonly engineLoader: () => Promise<MemoryEngine>;
  private readonly maxContextTokens: number;
  private readonly defaultLimit: number;
  private readonly noteIndex?: StructuredMemoryNoteIndex;

  constructor(options: ChecklistMemoryProviderOptions) {
    this.engineLoader = options.engineLoader;
    this.maxContextTokens = options.maxContextTokens ?? 1_500;
    this.defaultLimit = options.defaultLimit ?? 10;
    this.noteIndex = options.noteIndex;
  }

  async retrieve(query: RagQuery): Promise<RetrievedContext[]> {
    if (!query.text.trim()) {
      return [];
    }
    const engine = await this.engineLoader();
    const scope: MemoryRecordScope = {
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.conversationId ? { conversationId: query.conversationId } : {}),
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.threadId ? { threadId: query.threadId } : {}),
    };
    const limit = normalizeLimit(query.limit, this.defaultLimit);
    const input: QueryInput = {
      scope,
      text: query.text,
      limit,
    };
    let records: MemoryRecord[];
    try {
      records = await engine.query(input);
    } catch (error) {
      console.error(
        '[WARN] structured-memory retrieval failed:',
        error instanceof Error ? error.message : String(error),
      );
      return [];
    }
    const keywordContexts = records.map((record) => toRetrievedContext(record));

    // Semantic session-note search (optional). Merged with the keyword results
    // via reciprocal rank fusion. Graceful fallback: returns [] when no note
    // index is configured or the vector search throws.
    let vectorContexts: RetrievedContext[] = [];
    if (this.noteIndex?.available) {
      try {
        vectorContexts = await this.noteIndex.search({
          text: query.text,
          scope,
          limit,
        });
      } catch (error) {
        console.error(
          '[WARN] structured-memory vector search failed:',
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    const merged = reciprocalRankFusion([keywordContexts, vectorContexts]);
    return truncateToTokenBudget(merged, this.maxContextTokens);
  }
}

/** Render a structured record as a `RetrievedContext` with stable content. */
export function toRetrievedContext(record: MemoryRecord): RetrievedContext {
  const content = renderContent(record);
  return {
    id: `structured-memory:${record.id}`,
    provider: 'structured-memory',
    title: record.title,
    content,
    score: 1,
    metadata: {
      kind: record.kind,
      recordId: record.id,
      scope: record.scope,
      tags: record.tags,
      status: record.status,
      updatedAt: record.updatedAt,
      tokenEstimate: estimateTextTokens(content),
    },
  };
}

function renderContent(record: MemoryRecord): string {
  if (record.kind === 'checklist') {
    const items = record.items
      .map((item) => `  - [${item.status}] ${item.title}${item.description ? ` — ${item.description}` : ''}`)
      .join('\n');
    return `Checklist: ${record.title}${record.description ? `\n${record.description}` : ''}\n${items}`;
  }
  if (record.kind === 'todo') {
    return `Todo [${record.status}|${record.priority}]: ${record.title}${record.description ? `\n${record.description}` : ''}`;
  }
  return `Note (${record.importance}): ${record.title}\n${record.content}`;
}

/** Normalize a caller-supplied limit: reject NaN/Infinity/non-positive, clamp to the engine hard cap. */
function normalizeLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(100, Math.max(1, Math.floor(value)));
}

function truncateToTokenBudget(contexts: RetrievedContext[], maxTokens: number): RetrievedContext[] {
  const result: RetrievedContext[] = [];
  let used = 0;
  for (const context of contexts) {
    const estimate =
      typeof context.metadata?.tokenEstimate === 'number'
        ? (context.metadata.tokenEstimate as number)
        : estimateTextTokens(context.content);
    if (used + estimate > maxTokens && result.length > 0) {
      break;
    }
    result.push(context);
    used += estimate;
  }
  return result;
}
