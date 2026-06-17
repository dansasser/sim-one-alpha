/**
 * Inferred types for the Memory Helper. The schema file
 * `src/schemas/memory.ts` is the source of truth; this module is a
 * pure re-export layer per `docs/architecture/schema-strategy.md`.
 *
 * No `interface` or `type` declarations are added in this file.
 */

import type { InferOutput } from 'valibot';

import type {
  AddChecklistItemInputSchema,
  ChecklistItemStatusSchema,
  ChecklistSchema,
  ChecklistStatusSchema,
  CreateChecklistInputSchema,
  CreateSessionNoteInputSchema,
  CreateTodoInputSchema,
  DeleteInputSchema,
  MemoryRecordSchema,
  MemoryRecordScopeSchema,
  MemoryRecordSnapshotSchema,
  QueryInputSchema,
  SessionNoteImportanceSchema,
  SessionNoteSchema,
  SessionNoteStatusSchema,
  TodoPrioritySchema,
  TodoSchema,
  TodoStatusSchema,
  UpdateChecklistInputSchema,
  UpdateChecklistItemInputSchema,
  UpdateSessionNoteInputSchema,
  UpdateTodoInputSchema,
} from '../schemas/memory.js';

export type MemoryRecordScope = InferOutput<typeof MemoryRecordScopeSchema>;
export type ChecklistItemStatus = InferOutput<typeof ChecklistItemStatusSchema>;
export type ChecklistStatus = InferOutput<typeof ChecklistStatusSchema>;
export type TodoStatus = InferOutput<typeof TodoStatusSchema>;
export type TodoPriority = InferOutput<typeof TodoPrioritySchema>;
export type SessionNoteStatus = InferOutput<typeof SessionNoteStatusSchema>;
export type SessionNoteImportance = InferOutput<typeof SessionNoteImportanceSchema>;

export type ChecklistItem = InferOutput<typeof ChecklistSchema>['items'][number];
export type Checklist = InferOutput<typeof ChecklistSchema>;
export type Todo = InferOutput<typeof TodoSchema>;
export type SessionNote = InferOutput<typeof SessionNoteSchema>;
export type MemoryRecord = InferOutput<typeof MemoryRecordSchema>;
export type MemoryRecordSnapshot = InferOutput<typeof MemoryRecordSnapshotSchema>;

export type CreateChecklistInput = InferOutput<typeof CreateChecklistInputSchema>;
export type UpdateChecklistInput = InferOutput<typeof UpdateChecklistInputSchema>;
export type AddChecklistItemInput = InferOutput<typeof AddChecklistItemInputSchema>;
export type UpdateChecklistItemInput = InferOutput<typeof UpdateChecklistItemInputSchema>;
export type CreateTodoInput = InferOutput<typeof CreateTodoInputSchema>;
export type UpdateTodoInput = InferOutput<typeof UpdateTodoInputSchema>;
export type CreateSessionNoteInput = InferOutput<typeof CreateSessionNoteInputSchema>;
export type UpdateSessionNoteInput = InferOutput<typeof UpdateSessionNoteInputSchema>;
export type QueryInput = InferOutput<typeof QueryInputSchema>;
export type DeleteInput = InferOutput<typeof DeleteInputSchema>;
