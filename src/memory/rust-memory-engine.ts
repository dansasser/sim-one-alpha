import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as v from 'valibot';
import type { MemoryEngine } from './memory-engine.js';
import {
  ChecklistSchema,
  MemoryRecordSchema,
  MemoryRecordSnapshotSchema,
  SessionNoteSchema,
  TodoSchema,
} from '../schemas/memory.js';
import type {
  AddChecklistItemInput,
  Checklist,
  CreateChecklistInput,
  CreateSessionNoteInput,
  CreateTodoInput,
  DeleteInput,
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

export enum MemoryEngineErrorKind {
  Validation = 'validation',
  NotFound = 'not_found',
  Conflict = 'conflict',
  Internal = 'internal',
}

export class MemoryEngineError extends Error {
  constructor(
    public readonly kind: MemoryEngineErrorKind,
    message: string,
  ) {
    super(message);
  }
}

function mapWasmError(error: string): MemoryEngineError {
  const prefixes: [string, MemoryEngineErrorKind][] = [
    ['validation:', MemoryEngineErrorKind.Validation],
    ['not_found:', MemoryEngineErrorKind.NotFound],
    ['conflict:', MemoryEngineErrorKind.Conflict],
    ['internal:', MemoryEngineErrorKind.Internal],
  ];
  for (const [prefix, kind] of prefixes) {
    if (error.startsWith(prefix)) {
      return new MemoryEngineError(kind, error.slice(prefix.length));
    }
  }
  return new MemoryEngineError(MemoryEngineErrorKind.Internal, error);
}

function defaultWasmPath(): string {
  const here = fileURLToPath(import.meta.url);
  if (here.includes('.tmp/tsc/')) {
    return resolve(dirname(here), '../../../crates/gorombo-memory/pkg/gorombo_memory.js');
  }
  return resolve(dirname(here), '../../crates/gorombo-memory/pkg/gorombo_memory.js');
}

export interface RustMemoryEngineOptions {
  wasmPath?: string;
  expectedVersion: string;
}

interface WasmModule {
  memory_helper_version: () => string;
  reconcile_index: (json: string) => string;
  create_checklist: (json: string) => string;
  update_checklist: (json: string) => string;
  add_checklist_item: (json: string) => string;
  update_checklist_item: (json: string) => string;
  create_todo: (json: string) => string;
  update_todo: (json: string) => string;
  create_session_note: (json: string) => string;
  update_session_note: (json: string) => string;
  query_records: (json: string) => string;
  delete_record: (json: string) => string;
}

export class RustMemoryEngine implements MemoryEngine {
  private module: WasmModule;
  private expectedVersion: string;

  private constructor(module: WasmModule, expectedVersion: string) {
    this.module = module;
    this.expectedVersion = expectedVersion;
  }

  static async load(options: RustMemoryEngineOptions): Promise<RustMemoryEngine> {
    const wasmPath = options.wasmPath ?? defaultWasmPath();
    const mod = (await import(/* webpackIgnore: true */ wasmPath)) as WasmModule;
    const version = mod.memory_helper_version();
    if (version !== options.expectedVersion) {
      throw new MemoryEngineError(
        MemoryEngineErrorKind.Internal,
        `WASM version mismatch: expected ${options.expectedVersion}, got ${version}`,
      );
    }
    return new RustMemoryEngine(mod, options.expectedVersion);
  }

  async version(): Promise<string> {
    return this.module.memory_helper_version();
  }

  async reconcile(snapshot: MemoryRecordSnapshot): Promise<void> {
    this.module.reconcile_index(JSON.stringify(snapshot));
  }

  async createChecklist(input: CreateChecklistInput): Promise<Checklist> {
    const raw = this.module.create_checklist(JSON.stringify(input));
    return v.parse(ChecklistSchema, JSON.parse(raw));
  }

  async updateChecklist(input: UpdateChecklistInput): Promise<Checklist> {
    const raw = this.module.update_checklist(JSON.stringify(input));
    return v.parse(ChecklistSchema, JSON.parse(raw));
  }

  async addChecklistItem(input: AddChecklistItemInput): Promise<Checklist> {
    const raw = this.module.add_checklist_item(JSON.stringify(input));
    return v.parse(ChecklistSchema, JSON.parse(raw));
  }

  async updateChecklistItem(input: UpdateChecklistItemInput): Promise<Checklist> {
    const raw = this.module.update_checklist_item(JSON.stringify(input));
    return v.parse(ChecklistSchema, JSON.parse(raw));
  }

  async createTodo(input: CreateTodoInput): Promise<Todo> {
    const raw = this.module.create_todo(JSON.stringify(input));
    return v.parse(TodoSchema, JSON.parse(raw));
  }

  async updateTodo(input: UpdateTodoInput): Promise<Todo> {
    const raw = this.module.update_todo(JSON.stringify(input));
    return v.parse(TodoSchema, JSON.parse(raw));
  }

  async createSessionNote(input: CreateSessionNoteInput): Promise<SessionNote> {
    const raw = this.module.create_session_note(JSON.stringify(input));
    return v.parse(SessionNoteSchema, JSON.parse(raw));
  }

  async updateSessionNote(input: UpdateSessionNoteInput): Promise<SessionNote> {
    const raw = this.module.update_session_note(JSON.stringify(input));
    return v.parse(SessionNoteSchema, JSON.parse(raw));
  }

  async query(
    input: QueryInput,
  ): Promise<{ records: MemoryRecord[]; totalScanned: number }> {
    const raw = this.module.query_records(JSON.stringify(input));
    const parsed = JSON.parse(raw);
    return {
      records: parsed.records.map((r: unknown) => v.parse(MemoryRecordSchema, r)),
      totalScanned: parsed.totalScanned,
    };
  }

  async delete(input: DeleteInput): Promise<void> {
    this.module.delete_record(JSON.stringify(input));
  }
}

// ---------------------------------------------------------------------------
// In-memory reference backend used for parity tests and lightweight unit tests.
// It mirrors the WASM contract but keeps all state in JavaScript Maps.
// ---------------------------------------------------------------------------

import { matchesScope } from './scope-match.js';

export interface InMemoryMemoryEngineOptions {
  defaultLimit?: number;
}

export class InMemoryMemoryEngine implements MemoryEngine {
  private records = new Map<string, MemoryRecord>();
  private defaultLimit: number;

  constructor(options: InMemoryMemoryEngineOptions = {}) {
    this.defaultLimit = options.defaultLimit ?? 20;
  }

  async version(): Promise<string> {
    return 'in-memory';
  }

  async reconcile(snapshot: MemoryRecordSnapshot): Promise<void> {
    this.records.clear();
    for (const record of snapshot.records) {
      this.records.set(record.id, record);
    }
  }

  async createChecklist(input: CreateChecklistInput): Promise<Checklist> {
    const now = new Date().toISOString();
    const checklist: Checklist = {
      id: generateId(),
      kind: 'checklist',
      title: input.title,
      slug: input.slug,
      description: input.description,
      scope: input.scope,
      tags: input.tags ?? [],
      status: 'active',
      items: (input.items ?? []).map((item, index) => ({
        id: item.id ?? generateId(),
        parentId: item.parentId,
        title: item.title,
        description: item.description,
        status: item.status ?? 'pending',
        ordinal: item.ordinal ?? index,
        tags: item.tags ?? [],
        dueAt: item.dueAt,
        completedAt: item.completedAt,
        children: [],
      })),
      createdAt: now,
      updatedAt: now,
      updatedBy: input.audit.updatedBy,
      runId: input.audit.runId,
    };
    this.records.set(checklist.id, checklist);
    return checklist;
  }

  async updateChecklist(input: UpdateChecklistInput): Promise<Checklist> {
    const existing = this.records.get(input.id);
    if (!existing || existing.kind !== 'checklist') {
      throw new MemoryEngineError(
        MemoryEngineErrorKind.NotFound,
        `checklist ${input.id}`,
      );
    }
    const updated: Checklist = {
      ...existing,
      title: input.title ?? existing.title,
      slug: input.slug ?? existing.slug,
      description: input.description ?? existing.description,
      tags: input.tags ?? existing.tags,
      status: input.status ?? existing.status,
      updatedAt: new Date().toISOString(),
      updatedBy: input.audit.updatedBy,
      runId: input.audit.runId,
    };
    this.records.set(updated.id, updated);
    return updated;
  }

  async addChecklistItem(input: AddChecklistItemInput): Promise<Checklist> {
    const existing = this.records.get(input.checklistId);
    if (!existing || existing.kind !== 'checklist') {
      throw new MemoryEngineError(
        MemoryEngineErrorKind.NotFound,
        `checklist ${input.checklistId}`,
      );
    }
    const item = input.item;
    const newItem: Checklist['items'][number] = {
      id: item.id ?? generateId(),
      parentId: item.parentId,
      title: item.title,
      description: item.description,
      status: item.status ?? 'pending',
      ordinal: item.ordinal ?? existing.items.length,
      tags: item.tags ?? [],
      dueAt: item.dueAt,
      completedAt: item.completedAt,
      children: [],
    };
    const updated: Checklist = {
      ...existing,
      items: [...existing.items, newItem],
      updatedAt: new Date().toISOString(),
      updatedBy: input.audit.updatedBy,
      runId: input.audit.runId,
    };
    this.records.set(updated.id, updated);
    return updated;
  }

  async updateChecklistItem(input: UpdateChecklistItemInput): Promise<Checklist> {
    const existing = this.records.get(input.checklistId);
    if (!existing || existing.kind !== 'checklist') {
      throw new MemoryEngineError(
        MemoryEngineErrorKind.NotFound,
        `checklist ${input.checklistId}`,
      );
    }
    const items = existing.items.map((item) => {
      if (item.id !== input.itemId) return item;
      return {
        ...item,
        title: input.patch.title ?? item.title,
        description: input.patch.description ?? item.description,
        status: input.patch.status ?? item.status,
        ordinal: input.patch.ordinal ?? item.ordinal,
        tags: input.patch.tags ?? item.tags,
        dueAt: input.patch.dueAt ?? item.dueAt,
        completedAt: input.patch.completedAt ?? item.completedAt,
        parentId: input.patch.parentId === null ? undefined : (input.patch.parentId ?? item.parentId),
      };
    });
    const updated: Checklist = {
      ...existing,
      items,
      updatedAt: new Date().toISOString(),
      updatedBy: input.audit.updatedBy,
      runId: input.audit.runId,
    };
    this.records.set(updated.id, updated);
    return updated;
  }

  async createTodo(input: CreateTodoInput): Promise<Todo> {
    const now = new Date().toISOString();
    const todo: Todo = {
      id: generateId(),
      kind: 'todo',
      title: input.title,
      slug: input.slug,
      description: input.description,
      scope: input.scope,
      priority: input.priority ?? 'normal',
      status: input.status ?? 'pending',
      tags: input.tags ?? [],
      dueAt: input.dueAt,
      completedAt: undefined,
      createdAt: now,
      updatedAt: now,
      updatedBy: input.audit.updatedBy,
      runId: input.audit.runId,
    };
    this.records.set(todo.id, todo);
    return todo;
  }

  async updateTodo(input: UpdateTodoInput): Promise<Todo> {
    const existing = this.records.get(input.id);
    if (!existing || existing.kind !== 'todo') {
      throw new MemoryEngineError(MemoryEngineErrorKind.NotFound, `todo ${input.id}`);
    }
    const updated: Todo = {
      ...existing,
      title: input.title ?? existing.title,
      description: input.description ?? existing.description,
      status: input.status ?? existing.status,
      priority: input.priority ?? existing.priority,
      tags: input.tags ?? existing.tags,
      dueAt: input.dueAt ?? existing.dueAt,
      completedAt: input.completedAt ?? existing.completedAt,
      updatedAt: new Date().toISOString(),
      updatedBy: input.audit.updatedBy,
      runId: input.audit.runId,
    };
    this.records.set(updated.id, updated);
    return updated;
  }

  async createSessionNote(input: CreateSessionNoteInput): Promise<SessionNote> {
    const now = new Date().toISOString();
    const note: SessionNote = {
      id: generateId(),
      kind: 'session_note',
      title: input.title,
      content: input.content,
      scope: input.scope,
      tags: input.tags ?? [],
      status: 'active',
      importance: input.importance ?? 'normal',
      createdAt: now,
      updatedAt: now,
      updatedBy: input.audit.updatedBy,
      runId: input.audit.runId,
    };
    this.records.set(note.id, note);
    return note;
  }

  async updateSessionNote(input: UpdateSessionNoteInput): Promise<SessionNote> {
    const existing = this.records.get(input.id);
    if (!existing || existing.kind !== 'session_note') {
      throw new MemoryEngineError(
        MemoryEngineErrorKind.NotFound,
        `session_note ${input.id}`,
      );
    }
    const updated: SessionNote = {
      ...existing,
      title: input.title ?? existing.title,
      content: input.content ?? existing.content,
      tags: input.tags ?? existing.tags,
      status: input.status ?? existing.status,
      importance: input.importance ?? existing.importance,
      updatedAt: new Date().toISOString(),
      updatedBy: input.audit.updatedBy,
      runId: input.audit.runId,
    };
    this.records.set(updated.id, updated);
    return updated;
  }

  async query(
    input: QueryInput,
  ): Promise<{ records: MemoryRecord[]; totalScanned: number }> {
    const text = (input.text ?? '').toLowerCase().trim();
    const tags = (input.tags ?? []).map((t) => t.toLowerCase());
    const kinds = input.kinds ?? [];
    const status = input.status ?? [];
    const limit = input.limit ?? this.defaultLimit;

    let scored: { record: MemoryRecord; score: number }[] = [];
    for (const record of this.records.values()) {
      if (kinds.length > 0 && !kinds.includes(record.kind)) continue;
      if (status.length > 0 && !status.includes(record.status)) continue;
      if (!matchesScope(record.scope, input.scope)) continue;

      let score = 0;
      const title = record.title.toLowerCase();
      if (text) {
        if (title === text) {
          score += 1.0;
        } else if (title.includes(text)) {
          score += 0.5;
        }
      }
      if (tags.length > 0) {
        const recordTags = record.tags.map((t) => t.toLowerCase());
        const overlap = tags.filter((t) => recordTags.includes(t)).length;
        if (overlap > 0) {
          score += overlap / Math.max(tags.length, recordTags.length);
        }
      }

      if (score > 0 || (!text && tags.length === 0)) {
        scored.push({ record, score });
      }
    }

    scored.sort((a, b) => b.score - a.score || b.record.updatedAt.localeCompare(a.record.updatedAt));

    return {
      records: scored.slice(0, limit).map((s) => s.record),
      totalScanned: scored.length,
    };
  }

  async delete(input: DeleteInput): Promise<void> {
    const existing = this.records.get(input.id);
    if (!existing || existing.kind !== input.kind) {
      throw new MemoryEngineError(
        MemoryEngineErrorKind.NotFound,
        `${input.kind} ${input.id}`,
      );
    }
    this.records.delete(input.id);
  }
}

function generateId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

