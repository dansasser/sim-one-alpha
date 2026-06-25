import type {
  AddChecklistItemInput,
  Checklist,
  CreateChecklistInput,
  CreateSessionNoteInput,
  CreateTodoInput,
  DeleteInput,
  MemoryRecord,
  MemoryRecordSnapshot,
  MemoryEngineErrorKind,
  QueryInput,
  SessionNote,
  Todo,
  UpdateChecklistInput,
  UpdateChecklistItemInput,
  UpdateSessionNoteInput,
  UpdateTodoInput,
} from '../../core/types/memory.js';

/**
 * Error raised by a `MemoryEngine` implementation.
 *
 * The TS shim maps WASM `Err(String)` prefixes (`"validation:"`,
 * `"not_found:"`, `"conflict:"`, `"internal:"`) into the matching kind so
 * tool wrappers and providers can branch on it.
 */
export class MemoryEngineError extends Error {
  readonly kind: MemoryEngineErrorKind;
  readonly cause?: unknown;

  constructor(kind: MemoryEngineErrorKind, message: string, cause?: unknown) {
    super(message);
    this.name = 'MemoryEngineError';
    this.kind = kind;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/**
 * Structured-memory engine contract.
 *
 * Implementations:
 * - `RustMemoryEngine` — loads the `gorombo-memory` WASM and delegates every
 *   call to a `#[wasm_bindgen]` export (Phase 1).
 * - `InMemoryMemoryEngine` — pure-TypeScript backend used by unit tests as a
 *   parity reference for the WASM behavior (Phase 1).
 *
 * Boundary rules (see /opt/ai/plans/rust-memory-helper/plan.md):
 * - The engine owns no `actorId`/`conversationId`/`projectId`/`threadId`/`global`.
 *   Every caller injects scope. There is no global mutable cache in the engine.
 * - Mutating calls accept trusted scope and audit fields and return the
 *   resulting record(s); they never read the model's scope suggestion.
 * - `reconcile` is the only way to populate the WASM in-memory index after a
 *   cold start; the TS shim calls it with a snapshot from the durable store.
 *
 * This is the Phase 0 contract only — no implementation ships here.
 */
export interface MemoryEngine {
  /** Engine/module version. Used to assert the loaded WASM matches the expected build. */
  version(): Promise<string>;

  createChecklist(input: CreateChecklistInput): Promise<Checklist>;
  updateChecklist(input: UpdateChecklistInput): Promise<Checklist>;
  addChecklistItem(input: AddChecklistItemInput): Promise<Checklist>;
  updateChecklistItem(input: UpdateChecklistItemInput): Promise<Checklist>;

  createTodo(input: CreateTodoInput): Promise<Todo>;
  updateTodo(input: UpdateTodoInput): Promise<Todo>;

  createSessionNote(input: CreateSessionNoteInput): Promise<SessionNote>;
  updateSessionNote(input: UpdateSessionNoteInput): Promise<SessionNote>;

  /** Query the in-memory index. Returns records ranked by the engine. */
  query(input: QueryInput): Promise<MemoryRecord[]>;

  /** Soft/hard delete per the configured retention policy. */
  delete(input: DeleteInput): Promise<void>;

  /** Rebuild the in-memory index from a durable-store snapshot (cold start). */
  reconcile(snapshot: MemoryRecordSnapshot, maxChecklistDepth?: number): Promise<void>;
}
