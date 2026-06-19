import { createRequire } from 'node:module';

import type {
  AddChecklistItemInput,
  Checklist,
  ChecklistItem,
  CreateChecklistInput,
  CreateSessionNoteInput,
  CreateTodoInput,
  DeleteInput,
  MemoryEngineErrorKind,
  MemoryRecord,
  MemoryRecordSnapshot,
  QueryInput,
  SessionNote,
  Todo,
  UpdateChecklistInput,
  UpdateChecklistItemInput,
  UpdateSessionNoteInput,
  UpdateTodoInput,
} from '../types/memory.js';
import type { MemoryEngine, MemoryEngineError } from './memory-engine.js';
import { MemoryEngineError as MemoryEngineErrorClass } from './memory-engine.js';
import { ulid } from './ulid.js';

/** Re-export the error class so consumers can import it from the engine module. */
export { MemoryEngineErrorClass as MemoryEngineError };
export type { MemoryEngineErrorKind } from '../types/memory.js';

// ---------------------------------------------------------------------------
// Shared helpers used by both the WASM-backed engine and the in-memory engine.
// ---------------------------------------------------------------------------

export function nowIso(): string {
  return new Date().toISOString();
}

/** Scope match mirroring `crates/gorombo-memory/src/scope.rs::Scope::matches`. */
/** Verify an existing record's scope matches the trusted expected scope (cross-scope write guard). */
export function assertExpectedScope(
  existing: { actorId?: string; conversationId?: string; projectId?: string; threadId?: string; global?: boolean },
  expected: { actorId?: string; conversationId?: string; projectId?: string; threadId?: string; global?: boolean } | undefined,
  kind: string,
  id: string,
): void {
  if (!expected) {
    return;
  }
  if (!scopeMatches(existing, expected)) {
    throw new MemoryEngineErrorClass(
      'not_found',
      `${kind} ${id} not found in the requested scope`,
    );
  }
}

export function scopeMatches(
  recordScope: { actorId?: string; conversationId?: string; projectId?: string; threadId?: string; global?: boolean },
  queryScope: { actorId?: string; conversationId?: string; projectId?: string; threadId?: string; global?: boolean },
): boolean {
  const onlyGlobal =
    !recordScope.actorId &&
    !recordScope.conversationId &&
    !recordScope.projectId &&
    !recordScope.threadId &&
    recordScope.global === true;
  if (onlyGlobal) {
    return true;
  }
  if (recordScope.projectId !== undefined && recordScope.projectId !== queryScope.projectId) {
    return false;
  }
  if (recordScope.conversationId !== undefined && recordScope.conversationId !== queryScope.conversationId) {
    return false;
  }
  if (recordScope.actorId !== undefined && recordScope.actorId !== queryScope.actorId) {
    return false;
  }
  if (recordScope.threadId !== undefined && recordScope.threadId !== queryScope.threadId) {
    return false;
  }
  return true;
}

export function scopeIsEmpty(scope: { actorId?: string; conversationId?: string; projectId?: string; threadId?: string; global?: boolean }): boolean {
  return (
    !scope.actorId &&
    !scope.conversationId &&
    !scope.projectId &&
    !scope.threadId &&
    scope.global !== true
  );
}

function defaultChecklistItemStatus(status: ChecklistItem['status'] | undefined): ChecklistItem['status'] {
  return status ?? 'pending';
}

/** Build a full `Checklist` record from a create input (engine assigns ids/timestamps). */
export function buildChecklist(input: CreateChecklistInput, now = nowIso()): Checklist {
  const items: ChecklistItem[] = (input.items ?? []).map((item, index) => ({
    id: ulid(),
    parentId: item.parentId,
    title: item.title,
    description: item.description,
    status: defaultChecklistItemStatus(item.status),
    ordinal: item.ordinal ?? index,
    tags: item.tags ?? [],
    dueAt: item.dueAt,
    completedAt: item.status === 'completed' ? now : undefined,
  }));
  return {
    id: ulid(),
    kind: 'checklist',
    title: input.title,
    slug: input.slug,
    description: input.description,
    scope: input.scope,
    tags: input.tags ?? [],
    status: input.status ?? 'active',
    items,
    createdAt: now,
    updatedAt: now,
    updatedBy: input.updatedBy,
    runId: input.runId,
  };
}

export function buildTodo(input: CreateTodoInput, now = nowIso()): Todo {
  const status = input.status ?? 'pending';
  return {
    id: ulid(),
    kind: 'todo',
    title: input.title,
    slug: input.slug,
    description: input.description,
    scope: input.scope,
    priority: input.priority ?? 'normal',
    status,
    tags: input.tags ?? [],
    dueAt: input.dueAt,
    completedAt: status === 'completed' ? now : undefined,
    createdAt: now,
    updatedAt: now,
    updatedBy: input.updatedBy,
    runId: input.runId,
  };
}

export function buildSessionNote(input: CreateSessionNoteInput, now = nowIso()): SessionNote {
  return {
    id: ulid(),
    kind: 'session_note',
    title: input.title,
    content: input.content,
    scope: input.scope,
    tags: input.tags ?? [],
    status: input.status ?? 'active',
    importance: input.importance ?? 'normal',
    createdAt: now,
    updatedAt: now,
    updatedBy: input.updatedBy,
    runId: input.runId,
  };
}

/** Map a WASM `Err(String)` prefix into a typed `MemoryEngineError`. */
export function mapWasmError(message: string): MemoryEngineError {
  const [kindRaw, ...rest] = message.split(':');
  const detail = rest.join(':').trim();
  const kind: MemoryEngineErrorKind = (
    ['validation', 'not_found', 'conflict', 'internal'].includes(kindRaw ?? '')
      ? (kindRaw as MemoryEngineErrorKind)
      : 'internal'
  );
  return new MemoryEngineErrorClass(kind, detail || message);
}

// ---------------------------------------------------------------------------
// WASM-backed engine
// ---------------------------------------------------------------------------

/** Shape of the generated `gorombo_memory.js` module. */
export interface GoromboMemoryModule {
  memory_helper_version(): string;
  create_checklist(json: string): string;
  update_checklist(json: string): string;
  add_checklist_item(json: string): string;
  update_checklist_item(json: string): string;
  create_todo(json: string): string;
  update_todo(json: string): string;
  create_session_note(json: string): string;
  update_session_note(json: string): string;
  query_records(json: string): string;
  delete_record(json: string): string;
  reconcile_index(json: string): string;
}

export interface RustMemoryEngineLoadOptions {
  /** Absolute or relative path to the generated `gorombo_memory.js` module. */
  wasmModulePath: string;
  /** Expected module version; asserted against `memory_helper_version()`. */
  expectedVersion: string;
  /** Optional max checklist depth passed on reconcile (default 5). */
  maxChecklistDepth?: number;
}

/**
 * Memory engine backed by the `gorombo-memory` WASM module.
 *
 * The shim generates ids/timestamps/audit fields (Rust owns no clock/RNG in
 * the WASM target) and passes fully-formed records to the WASM exports. The
 * WASM module keeps a `thread_local` store for the instance lifetime; the
 * caller hydrates it from the durable store via `reconcile` on cold start.
 */
export class RustMemoryEngine implements MemoryEngine {
  private readonly module: GoromboMemoryModule;
  private readonly cache = new Map<string, MemoryRecord>();

  private constructor(module: GoromboMemoryModule) {
    this.module = module;
  }

  static async load(options: RustMemoryEngineLoadOptions): Promise<RustMemoryEngine> {
    const require = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const module = require(options.wasmModulePath) as GoromboMemoryModule;
    const version = module.memory_helper_version();
    if (version !== options.expectedVersion) {
      throw new MemoryEngineErrorClass(
        'internal',
        `gorombo-memory WASM version mismatch: expected ${options.expectedVersion}, loaded ${version}`,
      );
    }
    return new RustMemoryEngine(module);
  }

  version(): Promise<string> {
    return Promise.resolve(this.module.memory_helper_version());
  }

  async createChecklist(input: CreateChecklistInput): Promise<Checklist> {
    const record = (await this.call('create_checklist', buildChecklist(input))) as Checklist;
    this.cache.set(record.id, record);
    return record;
  }

  async updateChecklist(input: UpdateChecklistInput): Promise<Checklist> {
    const existing = this.cache.get(input.id);
    if (!existing || existing.kind !== 'checklist') {
      throw new MemoryEngineErrorClass('not_found', `checklist ${input.id} not found`);
    }
    assertExpectedScope(existing.scope, input.expectedScope, 'checklist', input.id);
    const next: Checklist = {
      ...existing,
      ...stripUndefined({
        title: input.title,
        slug: input.slug,
        description: input.description,
        scope: input.scope,
        tags: input.tags,
        status: input.status,
      }),
      updatedAt: nowIso(),
      updatedBy: input.updatedBy,
      runId: input.runId ?? existing.runId,
    };
    const record = (await this.call('update_checklist', next)) as Checklist;
    this.cache.set(record.id, record);
    return record;
  }

  async addChecklistItem(input: AddChecklistItemInput): Promise<Checklist> {
    const existing = this.cache.get(input.checklistId);
    if (!existing || existing.kind !== 'checklist') {
      throw new MemoryEngineErrorClass('not_found', `checklist ${input.checklistId} not found`);
    }
    assertExpectedScope(existing.scope, input.expectedScope, 'checklist', input.checklistId);
    const item = this.composeItem(input);
    const record = (await this.call('add_checklist_item', {
      checklistId: input.checklistId,
      item,
      updatedAt: nowIso(),
      updatedBy: input.updatedBy,
      runId: input.runId,
    })) as Checklist;
    this.cache.set(record.id, record);
    return record;
  }

  async updateChecklistItem(input: UpdateChecklistItemInput): Promise<Checklist> {
    const existing = this.cache.get(input.checklistId);
    if (!existing || existing.kind !== 'checklist') {
      throw new MemoryEngineErrorClass('not_found', `checklist ${input.checklistId} not found`);
    }
    assertExpectedScope(existing.scope, input.expectedScope, 'checklist', input.checklistId);
    const current = existing.items.find((i) => i.id === input.itemId);
    if (!current) {
      throw new MemoryEngineErrorClass('not_found', `checklist item ${input.itemId} not found`);
    }
    const merged: ChecklistItem = {
      ...current,
      ...stripUndefined({
        parentId: input.parentId,
        title: input.title,
        description: input.description,
        status: input.status,
        ordinal: input.ordinal,
        tags: input.tags,
        dueAt: input.dueAt,
        completedAt: input.completedAt,
      }),
    };
    const record = (await this.call('update_checklist_item', {
      checklistId: input.checklistId,
      item: merged,
      updatedAt: nowIso(),
      updatedBy: input.updatedBy,
      runId: input.runId,
    })) as Checklist;
    this.cache.set(record.id, record);
    return record;
  }

  async createTodo(input: CreateTodoInput): Promise<Todo> {
    const record = (await this.call('create_todo', buildTodo(input))) as Todo;
    this.cache.set(record.id, record);
    return record;
  }

  async updateTodo(input: UpdateTodoInput): Promise<Todo> {
    const existing = this.cache.get(input.id);
    if (!existing || existing.kind !== 'todo') {
      throw new MemoryEngineErrorClass('not_found', `todo ${input.id} not found`);
    }
    assertExpectedScope(existing.scope, input.expectedScope, 'todo', input.id);
    const status = input.status ?? existing.status;
    const next: Todo = {
      ...existing,
      ...stripUndefined({
        title: input.title,
        slug: input.slug,
        description: input.description,
        scope: input.scope,
        priority: input.priority,
        status: input.status,
        tags: input.tags,
        dueAt: input.dueAt,
      }),
      status,
      completedAt: input.completedAt ?? (status === 'completed' ? nowIso() : existing.completedAt),
      updatedAt: nowIso(),
      updatedBy: input.updatedBy,
      runId: input.runId ?? existing.runId,
    };
    const record = (await this.call('update_todo', next)) as Todo;
    this.cache.set(record.id, record);
    return record;
  }

  async createSessionNote(input: CreateSessionNoteInput): Promise<SessionNote> {
    const record = (await this.call('create_session_note', buildSessionNote(input))) as SessionNote;
    this.cache.set(record.id, record);
    return record;
  }

  async updateSessionNote(input: UpdateSessionNoteInput): Promise<SessionNote> {
    const existing = this.cache.get(input.id);
    if (!existing || existing.kind !== 'session_note') {
      throw new MemoryEngineErrorClass('not_found', `session_note ${input.id} not found`);
    }
    assertExpectedScope(existing.scope, input.expectedScope, 'session_note', input.id);
    const next: SessionNote = {
      ...existing,
      ...stripUndefined({
        title: input.title,
        content: input.content,
        scope: input.scope,
        tags: input.tags,
        status: input.status,
        importance: input.importance,
      }),
      updatedAt: nowIso(),
      updatedBy: input.updatedBy,
      runId: input.runId ?? existing.runId,
    };
    const record = (await this.call('update_session_note', next)) as SessionNote;
    this.cache.set(record.id, record);
    return record;
  }

  async query(input: QueryInput): Promise<MemoryRecord[]> {
    const result = (await this.call('query_records', input)) as { records: MemoryRecord[]; totalScanned: number };
    return result.records;
  }

  async delete(input: DeleteInput): Promise<void> {
    await this.call('delete_record', input);
    this.cache.delete(input.id);
  }

  async reconcile(snapshot: MemoryRecordSnapshot, maxChecklistDepth?: number): Promise<void> {
    await this.callRaw('reconcile_index', {
      records: snapshot.records,
      maxChecklistDepth: maxChecklistDepth ?? 5,
    });
    this.cache.clear();
    for (const record of snapshot.records) {
      this.cache.set(record.id, record);
    }
  }

  // ---- internals --------------------------------------------------------

  private composeItem(input: AddChecklistItemInput): ChecklistItem {
    return {
      id: ulid(),
      parentId: input.parentId,
      title: input.title,
      description: input.description,
      status: input.status ?? 'pending',
      ordinal: input.ordinal ?? 0,
      tags: input.tags ?? [],
      dueAt: input.dueAt,
      completedAt: input.status === 'completed' ? nowIso() : undefined,
    };
  }

  private callRaw(exportName: keyof GoromboMemoryModule, payload: unknown): Promise<unknown> {
    let raw: string;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      raw = (this.module as any)[exportName](JSON.stringify(payload));
    } catch (error) {
      throw mapWasmError(error instanceof Error ? error.message : String(error));
    }
    try {
      return Promise.resolve(raw === 'null' ? undefined : JSON.parse(raw));
    } catch (error) {
      throw mapWasmError(`malformed WASM output: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private call<T>(exportName: keyof GoromboMemoryModule, payload: unknown): Promise<T> {
    return this.callRaw(exportName, payload) as Promise<T>;
  }
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, val] of Object.entries(value)) {
    if (val !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (result as any)[key] = val;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// In-memory engine (pure TS, used by unit tests as a parity reference)
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CHECKLIST_DEPTH = 5;
const DEFAULT_QUERY_LIMIT = 20;
const HARD_QUERY_CAP = 100;

/**
 * Pure-TypeScript engine mirroring the WASM behavior. Used by unit tests as a
 * parity reference: the same scripted sequence run against both engines must
 * produce structurally equal results.
 */
export class InMemoryMemoryEngine implements MemoryEngine {
  private readonly store = new Map<string, MemoryRecord>();
  private maxChecklistDepth = DEFAULT_MAX_CHECKLIST_DEPTH;

  async version(): Promise<string> {
    return Promise.resolve('in-memory');
  }

  async createChecklist(input: CreateChecklistInput): Promise<Checklist> {
    const checklist = buildChecklist(input);
    this.validateChecklistInvariants(checklist);
    this.store.set(checklist.id, checklist);
    return checklist;
  }

  async updateChecklist(input: UpdateChecklistInput): Promise<Checklist> {
    const existing = this.store.get(input.id);
    if (!existing || existing.kind !== 'checklist') {
      throw new MemoryEngineErrorClass('not_found', `checklist ${input.id} not found`);
    }
    assertExpectedScope(existing.scope, input.expectedScope, 'checklist', input.id);
    const next: Checklist = {
      ...existing,
      ...stripUndefined({
        title: input.title,
        slug: input.slug,
        description: input.description,
        scope: input.scope,
        tags: input.tags,
        status: input.status,
      }),
      updatedAt: nowIso(),
      updatedBy: input.updatedBy,
      runId: input.runId ?? existing.runId,
    };
    this.validateChecklistInvariants(next);
    this.store.set(next.id, next);
    return next;
  }

  async addChecklistItem(input: AddChecklistItemInput): Promise<Checklist> {
    const existing = this.store.get(input.checklistId);
    if (!existing || existing.kind !== 'checklist') {
      throw new MemoryEngineErrorClass('not_found', `checklist ${input.checklistId} not found`);
    }
    assertExpectedScope(existing.scope, input.expectedScope, 'checklist', input.checklistId);
    const item: ChecklistItem = {
      id: ulid(),
      parentId: input.parentId,
      title: input.title,
      description: input.description,
      status: input.status ?? 'pending',
      ordinal: input.ordinal ?? 0,
      tags: input.tags ?? [],
      dueAt: input.dueAt,
      completedAt: input.status === 'completed' ? nowIso() : undefined,
    };
    const next: Checklist = {
      ...existing,
      items: [...existing.items.filter((i) => i.id !== item.id), item],
      updatedAt: nowIso(),
    };
    this.validateChecklistInvariants(next);
    this.store.set(next.id, next);
    return next;
  }

  async updateChecklistItem(input: UpdateChecklistItemInput): Promise<Checklist> {
    const existing = this.store.get(input.checklistId);
    if (!existing || existing.kind !== 'checklist') {
      throw new MemoryEngineErrorClass('not_found', `checklist ${input.checklistId} not found`);
    }
    assertExpectedScope(existing.scope, input.expectedScope, 'checklist', input.checklistId);
    const current = existing.items.find((i) => i.id === input.itemId);
    if (!current) {
      throw new MemoryEngineErrorClass('not_found', `checklist item ${input.itemId} not found`);
    }
    const merged: ChecklistItem = {
      ...current,
      ...stripUndefined({
        parentId: input.parentId,
        title: input.title,
        description: input.description,
        status: input.status,
        ordinal: input.ordinal,
        tags: input.tags,
        dueAt: input.dueAt,
        completedAt: input.completedAt,
      }),
    };
    const next: Checklist = {
      ...existing,
      items: existing.items.map((i) => (i.id === merged.id ? merged : i)),
      updatedAt: nowIso(),
    };
    this.validateChecklistInvariants(next);
    this.store.set(next.id, next);
    return next;
  }

  async createTodo(input: CreateTodoInput): Promise<Todo> {
    if (scopeIsEmpty(input.scope)) {
      throw new MemoryEngineErrorClass('validation', 'todo scope must be non-empty');
    }
    const todo = buildTodo(input);
    this.store.set(todo.id, todo);
    return todo;
  }

  async updateTodo(input: UpdateTodoInput): Promise<Todo> {
    const existing = this.store.get(input.id);
    if (!existing || existing.kind !== 'todo') {
      throw new MemoryEngineErrorClass('not_found', `todo ${input.id} not found`);
    }
    assertExpectedScope(existing.scope, input.expectedScope, 'todo', input.id);
    const status = input.status ?? existing.status;
    const next: Todo = {
      ...existing,
      ...stripUndefined({
        title: input.title,
        slug: input.slug,
        description: input.description,
        scope: input.scope,
        priority: input.priority,
        status: input.status,
        tags: input.tags,
        dueAt: input.dueAt,
      }),
      status,
      completedAt: input.completedAt ?? (status === 'completed' ? nowIso() : existing.completedAt),
      updatedAt: nowIso(),
      updatedBy: input.updatedBy,
      runId: input.runId ?? existing.runId,
    };
    this.store.set(next.id, next);
    return next;
  }

  async createSessionNote(input: CreateSessionNoteInput): Promise<SessionNote> {
    if (scopeIsEmpty(input.scope)) {
      throw new MemoryEngineErrorClass('validation', 'session_note scope must be non-empty');
    }
    const note = buildSessionNote(input);
    this.store.set(note.id, note);
    return note;
  }

  async updateSessionNote(input: UpdateSessionNoteInput): Promise<SessionNote> {
    const existing = this.store.get(input.id);
    if (!existing || existing.kind !== 'session_note') {
      throw new MemoryEngineErrorClass('not_found', `session_note ${input.id} not found`);
    }
    assertExpectedScope(existing.scope, input.expectedScope, 'session_note', input.id);
    const next: SessionNote = {
      ...existing,
      ...stripUndefined({
        title: input.title,
        content: input.content,
        scope: input.scope,
        tags: input.tags,
        status: input.status,
        importance: input.importance,
      }),
      updatedAt: nowIso(),
      updatedBy: input.updatedBy,
      runId: input.runId ?? existing.runId,
    };
    this.store.set(next.id, next);
    return next;
  }

  async query(input: QueryInput): Promise<MemoryRecord[]> {
    const limit = Math.min(input.limit ?? DEFAULT_QUERY_LIMIT, HARD_QUERY_CAP);
    const includeArchived = input.includeArchived ?? false;
    const kinds = input.kinds ?? [];
    let candidates = [...this.store.values()].filter((record) => {
      if (!includeArchived && isArchived(record)) {
        return false;
      }
      if (kinds.length > 0 && !kinds.includes(record.kind)) {
        return false;
      }
      return scopeMatches(record.scope, input.scope);
    });
    const text = (input.text ?? '').trim();
    const tags = input.tags ?? [];
    const words = text.length > 0 ? text.toLowerCase().split(/\s+/) : [];
    if (words.length > 0 || tags.length > 0) {
      candidates = candidates
        .map((record) => [record, rankScore(record, words, tags)] as const)
        .filter(([, score]) => score > 0)
        .sort((a, b) => b[1] - a[1] || b[0].updatedAt.localeCompare(a[0].updatedAt))
        .map(([record]) => record);
    } else {
      candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    return candidates.slice(0, limit);
  }

  async delete(input: DeleteInput): Promise<void> {
    this.store.delete(input.id);
  }

  async reconcile(snapshot: MemoryRecordSnapshot, maxChecklistDepth?: number): Promise<void> {
    if (maxChecklistDepth !== undefined) {
      this.maxChecklistDepth = Math.max(1, maxChecklistDepth);
    }
    this.store.clear();
    for (const record of snapshot.records) {
      this.store.set(record.id, record);
    }
  }

  private validateChecklistInvariants(checklist: Checklist): void {
    if (scopeIsEmpty(checklist.scope)) {
      throw new MemoryEngineErrorClass('validation', 'checklist scope must be non-empty');
    }
    if (!checklist.slug) {
      throw new MemoryEngineErrorClass('validation', 'checklist slug must be non-empty');
    }
    for (const record of this.store.values()) {
      if (record.kind !== 'checklist' || record.id === checklist.id) {
        continue;
      }
      if (
        record.slug === checklist.slug &&
        (scopeMatches(record.scope, checklist.scope) || scopeMatches(checklist.scope, record.scope))
      ) {
        throw new MemoryEngineErrorClass('conflict', `checklist slug '${checklist.slug}' already exists in this scope`);
      }
    }
    const seen = new Set<string>();
    for (const item of checklist.items) {
      if (seen.has(item.id)) {
        throw new MemoryEngineErrorClass('validation', `duplicate checklist item id ${item.id}`);
      }
      seen.add(item.id);
      if (item.parentId) {
        if (!checklist.items.some((i) => i.id === item.parentId)) {
          throw new MemoryEngineErrorClass('validation', `checklist item ${item.id} references unknown parentId ${item.parentId}`);
        }
        if (createsCycle(checklist, item.id, item.parentId)) {
          throw new MemoryEngineErrorClass('validation', `checklist item ${item.id} would form a cycle under ${item.parentId}`);
        }
      }
      const depth = itemDepth(checklist, item.id);
      if (depth > this.maxChecklistDepth) {
        throw new MemoryEngineErrorClass('validation', `checklist item ${item.id} exceeds max depth ${this.maxChecklistDepth}`);
      }
    }
  }
}

function isArchived(record: MemoryRecord): boolean {
  if (record.kind === 'checklist') {
    return record.status === 'archived' || record.archivedAt !== undefined;
  }
  if (record.kind === 'todo') {
    return record.archivedAt !== undefined;
  }
  return record.status === 'archived' || record.archivedAt !== undefined;
}

function createsCycle(checklist: Checklist, itemId: string, parentId: string): boolean {
  if (parentId === itemId) {
    return true;
  }
  let current: string | undefined = parentId;
  const guard = new Set<string>();
  while (current) {
    if (current === itemId) {
      return true;
    }
    if (guard.has(current)) {
      return false;
    }
    guard.add(current);
    const node = checklist.items.find((i) => i.id === current);
    current = node?.parentId;
  }
  return false;
}

function itemDepth(checklist: Checklist, itemId: string): number {
  let depth = 0;
  let current: string | undefined = itemId;
  const guard = new Set<string>();
  while (current) {
    depth += 1;
    if (guard.has(current) || depth > checklist.items.length) {
      return 0;
    }
    guard.add(current);
    const node = checklist.items.find((i) => i.id === current);
    current = node?.parentId;
  }
  return depth;
}

function rankScore(record: MemoryRecord, words: string[], tags: string[]): number {
  const title = record.title.toLowerCase();
  let kw = 0;
  if (words.length > 0) {
    if (words.length === 1 && title === words[0]) {
      kw = 1.0;
    } else {
      const hits = words.filter((w) => title.includes(w)).length;
      kw = (hits / words.length) * 0.7;
    }
  }
  let tag = 0;
  if (tags.length > 0) {
    const normTags = tags.map((t) => t.toLowerCase());
    const recordTags = record.tags.map((t) => t.toLowerCase());
    const hit = normTags.filter((t) => recordTags.includes(t)).length;
    tag = hit / normTags.length;
  }
  return Math.max(kw, tag);
}
