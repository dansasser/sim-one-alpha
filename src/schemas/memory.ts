import * as v from 'valibot';

/**
 * Structured-memory schemas for the Rust Memory Helper (WASM).
 *
 * Valibot is the source of truth for every structured-memory shape
 * (see docs/architecture/schema-strategy.md). `src/types/memory.ts`
 * re-exports the inferred types from this file; no hand-written
 * `interface`/`type` declarations for these shapes live anywhere else.
 *
 * Trust boundary: every mutating tool derives `scope` from a trusted
 * persisted `NormalizedMessageEvent`. The model never supplies scope.
 * The `*Input` schemas below include `scope` because the engine layer
 * (Rust WASM + TS shim) receives scope from the caller; the Flue tool
 * schemas in Phase 3 omit `scope` so the model cannot set it.
 */

/** Non-empty string helper. */
const NonEmptyString = v.pipe(v.string(), v.minLength(1));

/** Optional non-empty string. */
const OptionalNonEmptyString = v.optional(v.pipe(v.string(), v.minLength(1)));

/** ISO timestamp string (engine assigns; validated as non-empty string). */
const IsoTimestamp = NonEmptyString;

/** ULID (26-char base32) or other engine-assigned id. Validated as non-empty string. */
const RecordId = NonEmptyString;

/**
 * Scope that every structured-memory record is keyed by.
 *
 * At least one of `actorId`/`conversationId`/`projectId`/`threadId`/`global`
 * must be truthy in practice. That invariant is enforced by the engine's
 * `validate` path (Rust) and the TS trust boundary, not by the schema, so a
 * query can pass an empty scope to ask for global-only records.
 */
export const MemoryRecordScopeSchema = v.object({
  actorId: OptionalNonEmptyString,
  conversationId: OptionalNonEmptyString,
  projectId: OptionalNonEmptyString,
  threadId: OptionalNonEmptyString,
  global: v.optional(v.boolean()),
});
export type MemoryRecordScope = v.InferOutput<typeof MemoryRecordScopeSchema>;

export const ChecklistItemStatusSchema = v.picklist([
  'pending',
  'in_progress',
  'completed',
  'blocked',
  'skipped',
]);
export type ChecklistItemStatus = v.InferOutput<typeof ChecklistItemStatusSchema>;

export const ChecklistStatusSchema = v.picklist(['active', 'archived']);
export type ChecklistStatus = v.InferOutput<typeof ChecklistStatusSchema>;

export const TodoStatusSchema = v.picklist([
  'pending',
  'in_progress',
  'completed',
  'blocked',
  'cancelled',
]);
export type TodoStatus = v.InferOutput<typeof TodoStatusSchema>;

export const TodoPrioritySchema = v.picklist(['low', 'normal', 'high', 'urgent']);
export type TodoPriority = v.InferOutput<typeof TodoPrioritySchema>;

export const SessionNoteStatusSchema = v.picklist(['active', 'archived']);
export type SessionNoteStatus = v.InferOutput<typeof SessionNoteStatusSchema>;

export const SessionNoteImportanceSchema = v.picklist(['normal', 'high']);
export type SessionNoteImportance = v.InferOutput<typeof SessionNoteImportanceSchema>;

/**
 * One entry in a checklist. Nested items are a v1 feature (Decision 1): the
 * Rust engine stores children as a flat list with `parentId`; the TS layer
 * renders them as a tree on read. `ordinal` is per-parent. Cycle prevention
 * is enforced in the Rust `validate` path.
 */
export const ChecklistItemSchema = v.object({
  id: RecordId,
  parentId: v.optional(NonEmptyString),
  title: NonEmptyString,
  description: OptionalNonEmptyString,
  status: ChecklistItemStatusSchema,
  ordinal: v.number(),
  tags: v.array(NonEmptyString),
  dueAt: OptionalNonEmptyString,
  completedAt: OptionalNonEmptyString,
  // NOTE: `children` is intentionally absent from the stored/engine shape. The
  // Rust engine stores checklist items as a flat list keyed by `parentId`
  // (plan.md §Rust Crate Design and §1.5). The TS layer renders the tree at
  // read time; see `ChecklistItemTree` in src/types/memory.ts. Keeping the
  // stored schema non-recursive also avoids a strict-mode TS limitation on
  // self-referential Valibot schemas (TS7022/TS7024).
});
export type ChecklistItem = v.InferOutput<typeof ChecklistItemSchema>;

export const ChecklistSchema = v.object({
  id: RecordId,
  kind: v.literal('checklist'),
  title: NonEmptyString,
  slug: NonEmptyString,
  description: OptionalNonEmptyString,
  scope: MemoryRecordScopeSchema,
  tags: v.array(NonEmptyString),
  status: ChecklistStatusSchema,
  items: v.array(ChecklistItemSchema),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
  updatedBy: NonEmptyString,
  runId: OptionalNonEmptyString,
});
export type Checklist = v.InferOutput<typeof ChecklistSchema>;

export const TodoSchema = v.object({
  id: RecordId,
  kind: v.literal('todo'),
  title: NonEmptyString,
  slug: OptionalNonEmptyString,
  description: OptionalNonEmptyString,
  scope: MemoryRecordScopeSchema,
  priority: TodoPrioritySchema,
  status: TodoStatusSchema,
  tags: v.array(NonEmptyString),
  dueAt: OptionalNonEmptyString,
  completedAt: OptionalNonEmptyString,
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
  updatedBy: NonEmptyString,
  runId: OptionalNonEmptyString,
});
export type Todo = v.InferOutput<typeof TodoSchema>;

export const SessionNoteSchema = v.object({
  id: RecordId,
  kind: v.literal('session_note'),
  title: NonEmptyString,
  content: NonEmptyString,
  scope: MemoryRecordScopeSchema,
  tags: v.array(NonEmptyString),
  status: SessionNoteStatusSchema,
  importance: SessionNoteImportanceSchema,
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
  updatedBy: NonEmptyString,
  runId: OptionalNonEmptyString,
});
export type SessionNote = v.InferOutput<typeof SessionNoteSchema>;

/**
 * Discriminated union over `kind`. The record's own `kind` field tells the
 * consumer what the record is (Decision 10).
 */
export const MemoryRecordSchema = v.variant('kind', [
  ChecklistSchema,
  TodoSchema,
  SessionNoteSchema,
]);
export type MemoryRecord = v.InferOutput<typeof MemoryRecordSchema>;

/**
 * Snapshot of all persisted records. The TS shim passes this to
 * `reconcile_index` on cold start to rebuild the WASM in-memory index.
 */
export const MemoryRecordSnapshotSchema = v.object({
  records: v.array(MemoryRecordSchema),
});
export type MemoryRecordSnapshot = v.InferOutput<typeof MemoryRecordSnapshotSchema>;

/** Record kinds the engine stores. */
export const MemoryRecordKindSchema = v.picklist([
  'checklist',
  'todo',
  'session_note',
]);
export type MemoryRecordKind = v.InferOutput<typeof MemoryRecordKindSchema>;

// ---------------------------------------------------------------------------
// Engine input schemas (one per WASM export). These include `scope` because
// the engine layer receives scope from a trusted caller. Model-facing tool
// schemas (Phase 3) omit scope.
// ---------------------------------------------------------------------------

export const CreateChecklistInputSchema = v.object({
  title: NonEmptyString,
  slug: NonEmptyString,
  description: OptionalNonEmptyString,
  scope: MemoryRecordScopeSchema,
  tags: v.optional(v.array(NonEmptyString)),
  status: v.optional(ChecklistStatusSchema),
  /** Initial items (engine assigns id/ordinal). `parentId` references a sibling item id supplied in the same array. */
  items: v.optional(
    v.array(
      v.object({
        title: NonEmptyString,
        description: OptionalNonEmptyString,
        status: v.optional(ChecklistItemStatusSchema),
        ordinal: v.optional(v.number()),
        tags: v.optional(v.array(NonEmptyString)),
        dueAt: OptionalNonEmptyString,
        parentId: OptionalNonEmptyString,
      })
    )
  ),
});
export type CreateChecklistInput = v.InferOutput<typeof CreateChecklistInputSchema>;

export const UpdateChecklistInputSchema = v.object({
  id: RecordId,
  title: OptionalNonEmptyString,
  slug: OptionalNonEmptyString,
  description: OptionalNonEmptyString,
  scope: v.optional(MemoryRecordScopeSchema),
  tags: v.optional(v.array(NonEmptyString)),
  status: v.optional(ChecklistStatusSchema),
});
export type UpdateChecklistInput = v.InferOutput<typeof UpdateChecklistInputSchema>;

export const AddChecklistItemInputSchema = v.object({
  checklistId: RecordId,
  parentId: OptionalNonEmptyString,
  title: NonEmptyString,
  description: OptionalNonEmptyString,
  status: v.optional(ChecklistItemStatusSchema),
  ordinal: v.optional(v.number()),
  tags: v.optional(v.array(NonEmptyString)),
  dueAt: OptionalNonEmptyString,
});
export type AddChecklistItemInput = v.InferOutput<typeof AddChecklistItemInputSchema>;

export const UpdateChecklistItemInputSchema = v.object({
  checklistId: RecordId,
  itemId: RecordId,
  parentId: OptionalNonEmptyString,
  title: OptionalNonEmptyString,
  description: OptionalNonEmptyString,
  status: v.optional(ChecklistItemStatusSchema),
  ordinal: v.optional(v.number()),
  tags: v.optional(v.array(NonEmptyString)),
  dueAt: OptionalNonEmptyString,
  completedAt: OptionalNonEmptyString,
});
export type UpdateChecklistItemInput = v.InferOutput<
  typeof UpdateChecklistItemInputSchema
>;

export const CreateTodoInputSchema = v.object({
  title: NonEmptyString,
  slug: OptionalNonEmptyString,
  description: OptionalNonEmptyString,
  scope: MemoryRecordScopeSchema,
  priority: v.optional(TodoPrioritySchema),
  status: v.optional(TodoStatusSchema),
  tags: v.optional(v.array(NonEmptyString)),
  dueAt: OptionalNonEmptyString,
});
export type CreateTodoInput = v.InferOutput<typeof CreateTodoInputSchema>;

export const UpdateTodoInputSchema = v.object({
  id: RecordId,
  title: OptionalNonEmptyString,
  slug: OptionalNonEmptyString,
  description: OptionalNonEmptyString,
  scope: v.optional(MemoryRecordScopeSchema),
  priority: v.optional(TodoPrioritySchema),
  status: v.optional(TodoStatusSchema),
  tags: v.optional(v.array(NonEmptyString)),
  dueAt: OptionalNonEmptyString,
  completedAt: OptionalNonEmptyString,
});
export type UpdateTodoInput = v.InferOutput<typeof UpdateTodoInputSchema>;

export const CreateSessionNoteInputSchema = v.object({
  title: NonEmptyString,
  content: NonEmptyString,
  scope: MemoryRecordScopeSchema,
  tags: v.optional(v.array(NonEmptyString)),
  status: v.optional(SessionNoteStatusSchema),
  importance: v.optional(SessionNoteImportanceSchema),
});
export type CreateSessionNoteInput = v.InferOutput<typeof CreateSessionNoteInputSchema>;

export const UpdateSessionNoteInputSchema = v.object({
  id: RecordId,
  title: OptionalNonEmptyString,
  content: OptionalNonEmptyString,
  scope: v.optional(MemoryRecordScopeSchema),
  tags: v.optional(v.array(NonEmptyString)),
  status: v.optional(SessionNoteStatusSchema),
  importance: v.optional(SessionNoteImportanceSchema),
});
export type UpdateSessionNoteInput = v.InferOutput<
  typeof UpdateSessionNoteInputSchema
>;

export const QueryInputSchema = v.object({
  scope: MemoryRecordScopeSchema,
  text: v.optional(v.string()),
  kinds: v.optional(v.array(MemoryRecordKindSchema)),
  tags: v.optional(v.array(NonEmptyString)),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100))),
  includeArchived: v.optional(v.boolean()),
});
export type QueryInput = v.InferOutput<typeof QueryInputSchema>;

export const DeleteInputSchema = v.object({
  id: RecordId,
  kind: v.optional(MemoryRecordKindSchema),
});
export type DeleteInput = v.InferOutput<typeof DeleteInputSchema>;

/** Error kind surfaced by the TS shim from WASM `Err(String)` prefixes. */
export const MemoryEngineErrorKindSchema = v.picklist([
  'validation',
  'not_found',
  'conflict',
  'internal',
]);
export type MemoryEngineErrorKind = v.InferOutput<typeof MemoryEngineErrorKindSchema>;
