/**
 * Inferred type contracts for the Rust Memory Helper.
 *
 * Per docs/architecture/schema-strategy.md, Valibot is the single source of
 * truth. This file re-exports `v.InferOutput` types from
 * `src/schemas/memory.ts` plus the rendered tree projections used at read
 * time. Do not declare any `interface`/`type` of your own here for shapes that
 * have a schema — add the schema and infer from it.
 */

import type {
  Checklist,
  ChecklistItem,
} from '../schemas/memory.js';

export type {
  MemoryRecordScope,
  ChecklistItemStatus,
  ChecklistStatus,
  TodoStatus,
  TodoPriority,
  SessionNoteStatus,
  SessionNoteImportance,
  ChecklistItem,
  Checklist,
  Todo,
  SessionNote,
  MemoryRecord,
  MemoryRecordSnapshot,
  MemoryRecordKind,
  CreateChecklistInput,
  UpdateChecklistInput,
  AddChecklistItemInput,
  UpdateChecklistItemInput,
  CreateTodoInput,
  UpdateTodoInput,
  CreateSessionNoteInput,
  UpdateSessionNoteInput,
  QueryInput,
  DeleteInput,
  MemoryEngineErrorKind,
} from '../schemas/memory.js';

export {
  MemoryRecordScopeSchema,
  ChecklistItemStatusSchema,
  ChecklistStatusSchema,
  TodoStatusSchema,
  TodoPrioritySchema,
  SessionNoteStatusSchema,
  SessionNoteImportanceSchema,
  ChecklistItemSchema,
  ChecklistSchema,
  TodoSchema,
  SessionNoteSchema,
  MemoryRecordSchema,
  MemoryRecordSnapshotSchema,
  MemoryRecordKindSchema,
  CreateChecklistInputSchema,
  UpdateChecklistInputSchema,
  AddChecklistItemInputSchema,
  UpdateChecklistItemInputSchema,
  CreateTodoInputSchema,
  UpdateTodoInputSchema,
  CreateSessionNoteInputSchema,
  UpdateSessionNoteInputSchema,
  QueryInputSchema,
  DeleteInputSchema,
  MemoryEngineErrorKindSchema,
} from '../schemas/memory.js';

/**
 * Rendered (tree) projections of checklist records.
 *
 * The engine stores checklist items flat (keyed by `parentId`); the TS layer
 * renders them as a tree at read time (plan.md §Rust Crate Design and §1.5).
 * These shapes are TS-only render projections produced from already-validated
 * `Checklist`/`ChecklistItem` records — they have no Valibot schema because
 * they are constructed by code, not parsed from untrusted input. The stored
 * record schemas in `src/schemas/memory.ts` remain the source of truth.
 */
export interface ChecklistItemTree extends ChecklistItem {
  children: ChecklistItemTree[];
}

export interface ChecklistTree extends Omit<Checklist, 'items'> {
  items: ChecklistItemTree[];
}

/** Build a `ChecklistTree` from a flat `Checklist` by linking `parentId`. */
export function renderChecklistTree(checklist: Checklist): ChecklistTree {
  const byId = new Map<string, ChecklistItemTree>();
  for (const item of checklist.items) {
    byId.set(item.id, { ...item, children: [] });
  }
  const roots: ChecklistItemTree[] = [];
  for (const node of byId.values()) {
    const parentId = node.parentId;
    if (parentId && byId.has(parentId)) {
      byId.get(parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sortSiblings = (nodes: ChecklistItemTree[]): ChecklistItemTree[] => {
    nodes.sort((a, b) => a.ordinal - b.ordinal);
    for (const n of nodes) {
      n.children = sortSiblings(n.children);
    }
    return nodes;
  };
  return { ...checklist, items: sortSiblings(roots) };
}
