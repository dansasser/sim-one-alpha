import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AddChecklistItemInputSchema,
  ChecklistItemSchema,
  ChecklistSchema,
  CreateChecklistInputSchema,
  CreateSessionNoteInputSchema,
  CreateTodoInputSchema,
  DeleteInputSchema,
  MemoryEngineErrorKindSchema,
  MemoryRecordScopeSchema,
  MemoryRecordSchema,
  MemoryRecordSnapshotSchema,
  QueryInputSchema,
  SessionNoteSchema,
  TodoSchema,
  UpdateChecklistInputSchema,
  UpdateChecklistItemInputSchema,
  UpdateSessionNoteInputSchema,
  UpdateTodoInputSchema,
} from '../schemas/memory.js';
import { parseOrThrow } from './helpers/parse-or-throw.js';

const scope = { projectId: 'proj-1', conversationId: 'conv-1' };
const baseChecklistItem = {
  id: '01H5',
  title: 'Set up repo',
  status: 'pending',
  ordinal: 0,
  tags: [],
};

test('MemoryRecordScopeSchema accepts a populated scope and rejects an empty scope with empty-string ids', () => {
  parseOrThrow(MemoryRecordScopeSchema, scope);
  parseOrThrow(MemoryRecordScopeSchema, { global: true });
  // Empty-string id is rejected by minLength(1).
  assert.throws(() => parseOrThrow(MemoryRecordScopeSchema, { actorId: '' }));
});

test('ChecklistItemSchema validates a flat item and rejects a bad status', () => {
  parseOrThrow(ChecklistItemSchema, baseChecklistItem);
  // Valibot `v.object` ignores unknown keys by default; the Rust `validate`
  // path enforces strict-key rejection on the engine side (plan §validate.rs).
  assert.throws(() => parseOrThrow(ChecklistItemSchema, { ...baseChecklistItem, status: 'wat' }));
});

test('ChecklistSchema validates a full checklist and rejects a bad kind', () => {
  const checklist = {
    id: '01CL',
    kind: 'checklist',
    title: 'Phase 0 prep',
    slug: 'phase-0-prep',
    scope,
    tags: ['setup'],
    status: 'active',
    items: [baseChecklistItem],
    createdAt: '2026-06-18T00:00:00Z',
    updatedAt: '2026-06-18T00:00:00Z',
    updatedBy: 'orchestrator',
  };
  parseOrThrow(ChecklistSchema, checklist);
  assert.throws(() => parseOrThrow(ChecklistSchema, { ...checklist, kind: 'todo' }));
});

test('TodoSchema validates a todo and rejects an empty title', () => {
  const todo = {
    id: '01TD',
    kind: 'todo',
    title: 'Run smoke test',
    scope,
    priority: 'high',
    status: 'pending',
    tags: [],
    createdAt: '2026-06-18T00:00:00Z',
    updatedAt: '2026-06-18T00:00:00Z',
    updatedBy: 'orchestrator',
  };
  parseOrThrow(TodoSchema, todo);
  assert.throws(() => parseOrThrow(TodoSchema, { ...todo, title: '' }));
});

test('SessionNoteSchema validates a note and rejects an unknown importance', () => {
  const note = {
    id: '01SN',
    kind: 'session_note',
    title: 'Architecture decision',
    content: 'Use flat storage + tree render.',
    scope,
    tags: [],
    status: 'active',
    importance: 'high',
    createdAt: '2026-06-18T00:00:00Z',
    updatedAt: '2026-06-18T00:00:00Z',
    updatedBy: 'orchestrator',
  };
  parseOrThrow(SessionNoteSchema, note);
  assert.throws(() => parseOrThrow(SessionNoteSchema, { ...note, importance: 'critical' }));
});

test('MemoryRecordSchema is a discriminated union over kind', () => {
  parseOrThrow(MemoryRecordSchema, {
    id: '01TD',
    kind: 'todo',
    title: 'x',
    scope,
    priority: 'normal',
    status: 'pending',
    tags: [],
    createdAt: '2026-06-18T00:00:00Z',
    updatedAt: '2026-06-18T00:00:00Z',
    updatedBy: 'orchestrator',
  });
  // Missing discriminator value is rejected.
  assert.throws(() => parseOrThrow(MemoryRecordSchema, { kind: 'unknown' }));
});

test('MemoryRecordSnapshotSchema validates a snapshot of mixed records', () => {
  parseOrThrow(MemoryRecordSnapshotSchema, { records: [] });
  assert.throws(() => parseOrThrow(MemoryRecordSnapshotSchema, { records: [{}] }));
});

test('create/update input schemas carry scope and reject empty scope ids', () => {
  parseOrThrow(CreateChecklistInputSchema, { title: 't', slug: 's', scope, updatedBy: 'orchestrator' });
  parseOrThrow(UpdateChecklistInputSchema, { id: '01CL', title: 'new', updatedBy: 'orchestrator' });
  parseOrThrow(AddChecklistItemInputSchema, { checklistId: '01CL', title: 'item', updatedBy: 'orchestrator' });
  parseOrThrow(UpdateChecklistItemInputSchema, { checklistId: '01CL', itemId: '01H5', updatedBy: 'orchestrator' });
  parseOrThrow(CreateTodoInputSchema, { title: 't', scope, updatedBy: 'orchestrator' });
  parseOrThrow(UpdateTodoInputSchema, { id: '01TD', status: 'completed', updatedBy: 'orchestrator' });
  parseOrThrow(CreateSessionNoteInputSchema, { title: 't', content: 'c', scope, updatedBy: 'orchestrator' });
  parseOrThrow(UpdateSessionNoteInputSchema, { id: '01SN', content: 'new', updatedBy: 'orchestrator' });
  parseOrThrow(QueryInputSchema, { scope });
  parseOrThrow(DeleteInputSchema, { id: '01TD', updatedBy: 'orchestrator' });
  assert.throws(() => parseOrThrow(CreateChecklistInputSchema, { title: 't', slug: 's', scope: { projectId: '' }, updatedBy: 'orchestrator' }));
});

test('QueryInputSchema rejects an out-of-range limit', () => {
  parseOrThrow(QueryInputSchema, { scope, limit: 50 });
  assert.throws(() => parseOrThrow(QueryInputSchema, { scope, limit: 500 }));
  assert.throws(() => parseOrThrow(QueryInputSchema, { scope, limit: 1.5 }));
});

test('MemoryEngineErrorKindSchema accepts the four kinds', () => {
  for (const kind of ['validation', 'not_found', 'conflict', 'internal'] as const) {
    parseOrThrow(MemoryEngineErrorKindSchema, kind);
  }
  assert.throws(() => parseOrThrow(MemoryEngineErrorKindSchema, 'timeout'));
});
