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

/**
 * Versioned contract between the TypeScript host and the Memory Helper
 * (Rust/WASM) engine. Every method is async; the Rust backend serializes
 * to JSON over a thin WASM boundary, while the in-memory backend is
 * a strict subset used for unit tests.
 *
 * The engine owns no scope fields. The caller (Phase 2 provider,
 * Phase 3 tools) is responsible for deriving scope from a trusted
 * persisted `NormalizedMessageEvent` and passing it in `input.scope`.
 *
 * The TS shim asserts `version()` matches the expected build at load
 * time to prevent stale-binary reuse after a rebuild.
 */
export interface MemoryEngine {
  version(): Promise<string>;
  createChecklist(input: CreateChecklistInput): Promise<Checklist>;
  updateChecklist(input: UpdateChecklistInput): Promise<Checklist>;
  addChecklistItem(input: AddChecklistItemInput): Promise<Checklist>;
  updateChecklistItem(input: UpdateChecklistItemInput): Promise<Checklist>;
  createTodo(input: CreateTodoInput): Promise<Todo>;
  updateTodo(input: UpdateTodoInput): Promise<Todo>;
  createSessionNote(input: CreateSessionNoteInput): Promise<SessionNote>;
  updateSessionNote(input: UpdateSessionNoteInput): Promise<SessionNote>;
  query(input: QueryInput): Promise<{ records: MemoryRecord[]; totalScanned: number }>;
  delete(input: DeleteInput): Promise<void>;
  reconcile(snapshot: MemoryRecordSnapshot): Promise<void>;
}
