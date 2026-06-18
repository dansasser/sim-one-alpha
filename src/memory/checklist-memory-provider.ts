import { estimateTextTokens } from '../session/context-budget.js';
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

  constructor(options: ChecklistMemoryProviderOptions) {
    this.engineLoader = options.engineLoader;
    this.maxContextTokens = options.maxContextTokens ?? 1_500;
    this.defaultLimit = options.defaultLimit ?? 10;
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
    const input: QueryInput = {
      scope,
      text: query.text,
      limit: query.limit ?? this.defaultLimit,
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
    const contexts = records.map((record) => toRetrievedContext(record));
    return truncateToTokenBudget(contexts, this.maxContextTokens);
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
