import * as v from 'valibot';

/**
 * Schemas for the Memory Helper (Rust/WASM engine) structured-memory subsystem.
 *
 * Source of truth for all Memory Helper types. The TypeScript types in
 * `src/types/memory.ts` are inferred from these schemas via `v.InferOutput`.
 * No hand-written `interface` declarations are allowed for these shapes.
 *
 * Trust boundary: every mutating tool derives `MemoryRecordScope` from a
 * trusted persisted `NormalizedMessageEvent` via `getTrustedEvent`. The
 * schemas describe the on-the-wire shapes; the engine never trusts scope
 * fields supplied directly by the model.
 *
 * v1 supports nested checklist items (Decision 1). The recursion is expressed
 * with `v.lazy(...)` because Valibot does not allow direct self-references.
 */

const ULID_STRING = v.pipe(v.string(), v.minLength(1));

export const MemoryRecordScopeSchema = v.object({
  actorId: v.optional(v.pipe(v.string(), v.minLength(1))),
  conversationId: v.optional(v.pipe(v.string(), v.minLength(1))),
  projectId: v.optional(v.pipe(v.string(), v.minLength(1))),
  threadId: v.optional(v.pipe(v.string(), v.minLength(1))),
  global: v.optional(v.boolean()),
});

export const ChecklistItemStatusSchema = v.picklist([
  'pending',
  'in_progress',
  'completed',
  'blocked',
  'skipped',
]);

export const ChecklistStatusSchema = v.picklist(['active', 'archived']);

export const TodoStatusSchema = v.picklist([
  'pending',
  'in_progress',
  'completed',
  'blocked',
  'cancelled',
]);

export const TodoPrioritySchema = v.picklist(['low', 'normal', 'high', 'urgent']);

export const SessionNoteStatusSchema = v.picklist(['active', 'archived']);

export const SessionNoteImportanceSchema = v.picklist(['normal', 'high']);

/**
 * Recursive schema for nested checklist items. `v.lazy` is required for
 * Valibot's recursive type references. Cycle prevention and depth enforcement
 * live in the Rust `validate` path; the schema is shape-only.
 *
 * `ChecklistItemBase` is a base-shape type alias that breaks the circular
 * reference for TypeScript's structural checker. The const is annotated as
 * `GenericSchema<ChecklistItemBase>` so `v.InferOutput` yields the concrete
 * recursive object shape — children remain strongly typed.
 */
type ChecklistItemBase = {
  id: string;
  parentId?: string;
  title: string;
  description?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked' | 'skipped';
  ordinal: number;
  tags: string[];
  dueAt?: string;
  completedAt?: string;
  children: ChecklistItemBase[];
};

export const ChecklistItemSchema: v.GenericSchema<ChecklistItemBase, ChecklistItemBase> = v.object({
  id: ULID_STRING,
  parentId: v.optional(v.string()),
  title: v.pipe(v.string(), v.minLength(1)),
  description: v.optional(v.string()),
  status: ChecklistItemStatusSchema,
  ordinal: v.number(),
  tags: v.array(v.string()),
  dueAt: v.optional(v.string()),
  completedAt: v.optional(v.string()),
  children: v.array(v.lazy(() => ChecklistItemSchema)),
});

export const ChecklistSchema = v.object({
  id: ULID_STRING,
  kind: v.literal('checklist'),
  title: v.pipe(v.string(), v.minLength(1)),
  slug: v.pipe(v.string(), v.minLength(1)),
  description: v.optional(v.string()),
  scope: MemoryRecordScopeSchema,
  tags: v.array(v.string()),
  status: ChecklistStatusSchema,
  items: v.array(ChecklistItemSchema),
  createdAt: v.string(),
  updatedAt: v.string(),
  updatedBy: v.pipe(v.string(), v.minLength(1)),
  runId: v.optional(v.string()),
});

export const TodoSchema = v.object({
  id: ULID_STRING,
  kind: v.literal('todo'),
  title: v.pipe(v.string(), v.minLength(1)),
  slug: v.optional(v.string()),
  description: v.optional(v.string()),
  scope: MemoryRecordScopeSchema,
  priority: TodoPrioritySchema,
  status: TodoStatusSchema,
  tags: v.array(v.string()),
  dueAt: v.optional(v.string()),
  completedAt: v.optional(v.string()),
  createdAt: v.string(),
  updatedAt: v.string(),
  updatedBy: v.pipe(v.string(), v.minLength(1)),
  runId: v.optional(v.string()),
});

export const SessionNoteSchema = v.object({
  id: ULID_STRING,
  kind: v.literal('session_note'),
  title: v.pipe(v.string(), v.minLength(1)),
  content: v.pipe(v.string(), v.minLength(1)),
  scope: MemoryRecordScopeSchema,
  tags: v.array(v.string()),
  status: SessionNoteStatusSchema,
  importance: SessionNoteImportanceSchema,
  createdAt: v.string(),
  updatedAt: v.string(),
  updatedBy: v.pipe(v.string(), v.minLength(1)),
  runId: v.optional(v.string()),
});

export const MemoryRecordSchema = v.variant('kind', [
  ChecklistSchema,
  TodoSchema,
  SessionNoteSchema,
]);

/**
 * Cold-start snapshot passed to `reconcile_index` on every engine load.
 * The TS shim owns persistence; the WASM engine rebuilds its in-memory
 * index from this snapshot and never holds global mutable state between
 * calls.
 */
export const MemoryRecordSnapshotSchema = v.object({
  records: v.array(MemoryRecordSchema),
});

// -----------------------------------------------------------------------------
// Input schemas — one per WASM export.
// All inputs carry a `scope` field. The TS tool layer is responsible for
// deriving scope from a trusted `NormalizedMessageEvent` before calling
// the engine; the engine validates scope shape but does not trust scope
// values supplied by the model.
// -----------------------------------------------------------------------------

const MemoryRecordAuditSchema = v.object({
  updatedBy: v.pipe(v.string(), v.minLength(1)),
  runId: v.optional(v.string()),
});

const ChecklistItemInputSchema = v.object({
  id: v.optional(ULID_STRING),
  parentId: v.optional(v.string()),
  title: v.pipe(v.string(), v.minLength(1)),
  description: v.optional(v.string()),
  status: v.optional(ChecklistItemStatusSchema),
  ordinal: v.optional(v.number()),
  tags: v.optional(v.array(v.string())),
  dueAt: v.optional(v.string()),
  completedAt: v.optional(v.string()),
});

export const CreateChecklistInputSchema = v.object({
  title: v.pipe(v.string(), v.minLength(1)),
  slug: v.pipe(v.string(), v.minLength(1)),
  description: v.optional(v.string()),
  scope: MemoryRecordScopeSchema,
  tags: v.optional(v.array(v.string())),
  items: v.optional(v.array(ChecklistItemInputSchema)),
  audit: MemoryRecordAuditSchema,
});

export const UpdateChecklistInputSchema = v.object({
  id: ULID_STRING,
  title: v.optional(v.pipe(v.string(), v.minLength(1))),
  slug: v.optional(v.pipe(v.string(), v.minLength(1))),
  description: v.optional(v.string()),
  tags: v.optional(v.array(v.string())),
  status: v.optional(ChecklistStatusSchema),
  scope: MemoryRecordScopeSchema,
  audit: MemoryRecordAuditSchema,
});

export const AddChecklistItemInputSchema = v.object({
  checklistId: ULID_STRING,
  item: ChecklistItemInputSchema,
  scope: MemoryRecordScopeSchema,
  audit: MemoryRecordAuditSchema,
});

export const UpdateChecklistItemInputSchema = v.object({
  checklistId: ULID_STRING,
  itemId: ULID_STRING,
  patch: v.object({
    title: v.optional(v.pipe(v.string(), v.minLength(1))),
    description: v.optional(v.string()),
    status: v.optional(ChecklistItemStatusSchema),
    ordinal: v.optional(v.number()),
    tags: v.optional(v.array(v.string())),
    dueAt: v.optional(v.string()),
    completedAt: v.optional(v.string()),
    parentId: v.optional(v.union([v.string(), v.null()])),
  }),
  scope: MemoryRecordScopeSchema,
  audit: MemoryRecordAuditSchema,
});

export const CreateTodoInputSchema = v.object({
  title: v.pipe(v.string(), v.minLength(1)),
  slug: v.optional(v.pipe(v.string(), v.minLength(1))),
  description: v.optional(v.string()),
  scope: MemoryRecordScopeSchema,
  priority: v.optional(TodoPrioritySchema),
  status: v.optional(TodoStatusSchema),
  tags: v.optional(v.array(v.string())),
  dueAt: v.optional(v.string()),
  audit: MemoryRecordAuditSchema,
});

export const UpdateTodoInputSchema = v.object({
  id: ULID_STRING,
  title: v.optional(v.pipe(v.string(), v.minLength(1))),
  description: v.optional(v.string()),
  status: v.optional(TodoStatusSchema),
  priority: v.optional(TodoPrioritySchema),
  tags: v.optional(v.array(v.string())),
  dueAt: v.optional(v.string()),
  completedAt: v.optional(v.string()),
  scope: MemoryRecordScopeSchema,
  audit: MemoryRecordAuditSchema,
});

export const CreateSessionNoteInputSchema = v.object({
  title: v.pipe(v.string(), v.minLength(1)),
  content: v.pipe(v.string(), v.minLength(1)),
  scope: MemoryRecordScopeSchema,
  tags: v.optional(v.array(v.string())),
  importance: v.optional(SessionNoteImportanceSchema),
  audit: MemoryRecordAuditSchema,
});

export const UpdateSessionNoteInputSchema = v.object({
  id: ULID_STRING,
  title: v.optional(v.pipe(v.string(), v.minLength(1))),
  content: v.optional(v.pipe(v.string(), v.minLength(1))),
  tags: v.optional(v.array(v.string())),
  status: v.optional(SessionNoteStatusSchema),
  importance: v.optional(SessionNoteImportanceSchema),
  scope: MemoryRecordScopeSchema,
  audit: MemoryRecordAuditSchema,
});

export const QueryInputSchema = v.object({
  text: v.optional(v.string()),
  kinds: v.optional(v.array(v.picklist(['checklist', 'todo', 'session_note']))),
  tags: v.optional(v.array(v.string())),
  status: v.optional(v.array(v.string())),
  scope: MemoryRecordScopeSchema,
  limit: v.optional(v.pipe(v.number(), v.minValue(1), v.maxValue(100))),
});

export const DeleteInputSchema = v.object({
  id: ULID_STRING,
  kind: v.picklist(['checklist', 'todo', 'session_note']),
  scope: MemoryRecordScopeSchema,
  audit: MemoryRecordAuditSchema,
});
