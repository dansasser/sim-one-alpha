import assert from 'node:assert/strict';
import test from 'node:test';
import * as v from 'valibot';

import {
  AddChecklistItemInputSchema,
  ChecklistSchema,
  CreateChecklistInputSchema,
  CreateSessionNoteInputSchema,
  CreateTodoInputSchema,
  DeleteInputSchema,
  MemoryRecordSchema,
  MemoryRecordScopeSchema,
  MemoryRecordSnapshotSchema,
  QueryInputSchema,
  SessionNoteSchema,
  TodoSchema,
  UpdateChecklistInputSchema,
  UpdateSessionNoteInputSchema,
  UpdateTodoInputSchema,
} from '../schemas/memory.js';

const baseScope = { actorId: 'a-1', conversationId: 'c-1', projectId: 'p-1' };

const checklistFixture = {
  id: '01HZX8K1F2C3D4E5A6B7C8D9E0',
  kind: 'checklist' as const,
  title: 'Phase 0 prep',
  slug: 'phase-0-prep',
  description: 'shared contracts lead',
  scope: baseScope,
  tags: ['setup'],
  status: 'active' as const,
  items: [
    {
      id: '01HZX8K1F2C3D4E5A6B7C8D9E1',
      parentId: undefined,
      title: 'Schemas',
      description: undefined,
      status: 'pending' as const,
      ordinal: 0,
      tags: [],
      dueAt: undefined,
      completedAt: undefined,
      children: [
        {
          id: '01HZX8K1F2C3D4E5A6B7C8D9E2',
          parentId: '01HZX8K1F2C3D4E5A6B7C8D9E1',
          title: 'Valibot only',
          description: undefined,
          status: 'in_progress' as const,
          ordinal: 0,
          tags: [],
          dueAt: undefined,
          completedAt: undefined,
          children: [],
        },
      ],
    },
  ],
  createdAt: '2026-06-17T00:00:00.000Z',
  updatedAt: '2026-06-17T00:00:00.000Z',
  updatedBy: 'orchestrator',
  runId: undefined,
};

const todoFixture = {
  id: '01HZX8K1F2C3D4E5A6B7C8D9E3',
  kind: 'todo' as const,
  title: 'Run smoke test',
  slug: undefined,
  description: undefined,
  scope: baseScope,
  priority: 'normal' as const,
  status: 'pending' as const,
  tags: [],
  dueAt: undefined,
  completedAt: undefined,
  createdAt: '2026-06-17T00:00:00.000Z',
  updatedAt: '2026-06-17T00:00:00.000Z',
  updatedBy: 'orchestrator',
  runId: undefined,
};

const sessionNoteFixture = {
  id: '01HZX8K1F2C3D4E5A6B7C8D9E4',
  kind: 'session_note' as const,
  title: 'Architecture decision',
  content: 'Valibot-first; trust boundary is the persisted event.',
  scope: baseScope,
  tags: ['architecture'],
  status: 'active' as const,
  importance: 'normal' as const,
  createdAt: '2026-06-17T00:00:00.000Z',
  updatedAt: '2026-06-17T00:00:00.000Z',
  updatedBy: 'orchestrator',
  runId: undefined,
};

test('MemoryRecordScopeSchema accepts a populated scope and rejects an empty object in practice (enforced at validate_input, not schema)', () => {
  const parsed = v.parse(MemoryRecordScopeSchema, baseScope);
  assert.deepEqual(parsed, baseScope);
  // The schema is intentionally permissive — every key is optional. The
  // "at least one truthy key" rule lives in the Rust `validate` path so
  // the trust boundary is enforced server-side.
  const empty = v.parse(MemoryRecordScopeSchema, {});
  assert.deepEqual(empty, {});
});

test('ChecklistSchema accepts a checklist with a nested child', () => {
  const parsed = v.parse(ChecklistSchema, checklistFixture);
  assert.equal(parsed.items[0].children[0].title, 'Valibot only');
});

test('ChecklistSchema rejects unknown status values', () => {
  assert.throws(() =>
    v.parse(ChecklistSchema, { ...checklistFixture, status: 'weird' }),
  );
});

test('ChecklistSchema rejects empty title', () => {
  assert.throws(() => v.parse(ChecklistSchema, { ...checklistFixture, title: '' }));
});

test('TodoSchema accepts a todo and rejects bad priority', () => {
  const parsed = v.parse(TodoSchema, todoFixture);
  assert.equal(parsed.priority, 'normal');
  assert.throws(() => v.parse(TodoSchema, { ...todoFixture, priority: 'critical' }));
});

test('SessionNoteSchema accepts a note and rejects empty content', () => {
  const parsed = v.parse(SessionNoteSchema, sessionNoteFixture);
  assert.equal(parsed.kind, 'session_note');
  assert.throws(() => v.parse(SessionNoteSchema, { ...sessionNoteFixture, content: '' }));
});

test('MemoryRecordSchema is a discriminated union on kind', () => {
  assert.equal(v.parse(MemoryRecordSchema, checklistFixture).kind, 'checklist');
  assert.equal(v.parse(MemoryRecordSchema, todoFixture).kind, 'todo');
  assert.equal(v.parse(MemoryRecordSchema, sessionNoteFixture).kind, 'session_note');
  assert.throws(() => v.parse(MemoryRecordSchema, { kind: 'unknown' }));
});

test('MemoryRecordSnapshotSchema accepts a snapshot of all three kinds', () => {
  const parsed = v.parse(MemoryRecordSnapshotSchema, {
    records: [checklistFixture, todoFixture, sessionNoteFixture],
  });
  assert.equal(parsed.records.length, 3);
});

test('CreateChecklistInputSchema requires audit and scope', () => {
  const parsed = v.parse(CreateChecklistInputSchema, {
    title: 't',
    slug: 's',
    scope: baseScope,
    audit: { updatedBy: 'orchestrator' },
  });
  assert.equal(parsed.slug, 's');
  assert.throws(() =>
    v.parse(CreateChecklistInputSchema, {
      title: 't',
      slug: 's',
      scope: baseScope,
    }),
  );
});

test('AddChecklistItemInputSchema requires checklistId, item, scope, audit', () => {
  const parsed = v.parse(AddChecklistItemInputSchema, {
    checklistId: '01HZX8K1F2C3D4E5A6B7C8D9E0',
    item: { title: 'child' },
    scope: baseScope,
    audit: { updatedBy: 'orchestrator' },
  });
  assert.equal(parsed.item.title, 'child');
  assert.throws(() =>
    v.parse(AddChecklistItemInputSchema, {
      checklistId: '01HZX8K1F2C3D4E5A6B7C8D9E0',
      item: { title: 'child' },
      scope: baseScope,
    }),
  );
});

test('Update* schemas require id and audit; Create* do not require id', () => {
  assert.throws(() =>
    v.parse(UpdateChecklistInputSchema, {
      title: 'x',
      scope: baseScope,
      audit: { updatedBy: 'orchestrator' },
    }),
  );
  assert.throws(() =>
    v.parse(UpdateTodoInputSchema, {
      status: 'completed',
      scope: baseScope,
      audit: { updatedBy: 'orchestrator' },
    }),
  );
  assert.throws(() =>
    v.parse(UpdateSessionNoteInputSchema, {
      title: 'x',
      scope: baseScope,
      audit: { updatedBy: 'orchestrator' },
    }),
  );

  // Create* forms do not require id (engine assigns).
  assert.doesNotThrow(() =>
    v.parse(CreateTodoInputSchema, {
      title: 't',
      scope: baseScope,
      audit: { updatedBy: 'orchestrator' },
    }),
  );
  assert.doesNotThrow(() =>
    v.parse(CreateSessionNoteInputSchema, {
      title: 't',
      content: 'c',
      scope: baseScope,
      audit: { updatedBy: 'orchestrator' },
    }),
  );
});

test('QueryInputSchema rejects limit out of [1, 100]', () => {
  const base = { scope: baseScope };
  assert.throws(() => v.parse(QueryInputSchema, { ...base, limit: 0 }));
  assert.throws(() => v.parse(QueryInputSchema, { ...base, limit: 101 }));
  assert.doesNotThrow(() => v.parse(QueryInputSchema, { ...base, limit: 20 }));
});

test('DeleteInputSchema requires id, kind, scope, audit', () => {
  assert.throws(() =>
    v.parse(DeleteInputSchema, {
      id: '01HZX8K1F2C3D4E5A6B7C8D9E0',
      kind: 'checklist',
      scope: baseScope,
    }),
  );
  const parsed = v.parse(DeleteInputSchema, {
    id: '01HZX8K1F2C3D4E5A6B7C8D9E0',
    kind: 'checklist',
    scope: baseScope,
    audit: { updatedBy: 'orchestrator' },
  });
  assert.equal(parsed.kind, 'checklist');
});
