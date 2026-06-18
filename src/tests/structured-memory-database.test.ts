import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { GoromboStructuredMemoryDatabase } from '../memory/structured-memory-database.js';
import { ulid } from '../memory/ulid.js';
import type { Checklist, MemoryRecord, SessionNote, Todo } from '../types/memory.js';

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gorombo-mem-'));
  return join(dir, 'structured.sqlite');
}

function sampleChecklist(now: string): Checklist {
  const childId = ulid();
  return {
    id: ulid(),
    kind: 'checklist',
    title: 'Phase 0 prep',
    slug: 'phase-0-prep',
    description: 'Settle contracts.',
    scope: { projectId: 'proj-1', conversationId: 'conv-1' },
    tags: ['setup'],
    status: 'active',
    items: [
      { id: ulid(), title: 'Scaffold', status: 'completed', ordinal: 0, tags: [] },
      { id: childId, parentId: undefined, title: 'Schemas', status: 'in_progress', ordinal: 1, tags: [] },
      { id: ulid(), parentId: childId, title: 'Nested child', status: 'pending', ordinal: 0, tags: [] },
    ],
    createdAt: now,
    updatedAt: now,
    updatedBy: 'orchestrator',
  };
}

function sampleTodo(now: string): Todo {
  return {
    id: ulid(),
    kind: 'todo',
    title: 'Run smoke',
    scope: { projectId: 'proj-1', conversationId: 'conv-1' },
    priority: 'high',
    status: 'pending',
    tags: ['smoke'],
    createdAt: now,
    updatedAt: now,
    updatedBy: 'orchestrator',
  };
}

function sampleNote(now: string): SessionNote {
  return {
    id: ulid(),
    kind: 'session_note',
    title: 'Decision',
    content: 'flat store + tree render',
    scope: { projectId: 'proj-1', conversationId: 'conv-1' },
    tags: [],
    status: 'active',
    importance: 'high',
    createdAt: now,
    updatedAt: now,
    updatedBy: 'orchestrator',
  };
}

test('structured-memory database round-trips a checklist with a nested child, a todo, and a note', () => {
  const path = tmpDbPath();
  const now = '2026-06-18T00:00:00.000Z';
  const db = new GoromboStructuredMemoryDatabase({ filePath: path });
  const checklist = sampleChecklist(now);
  const todo = sampleTodo(now);
  const note = sampleNote(now);
  db.writeRecord(checklist);
  db.writeRecord(todo);
  db.writeRecord(note);

  const byId = db.getRecordById(checklist.id);
  assert.equal(byId?.kind, 'checklist');
  assert.equal((byId as Checklist)?.items.length, 3);
  const nested = (byId as Checklist).items.find((i) => i.title === 'Nested child');
  assert.ok(nested?.parentId, 'nested child retains parentId');

  const all = db.loadAllRecords();
  assert.equal(all.length, 3);
  db.close();

  // Reopen from the same file and confirm durable reads.
  const reopened = new GoromboStructuredMemoryDatabase({ filePath: path });
  const allAgain = reopened.loadAllRecords();
  assert.equal(allAgain.length, 3);
  assert.ok(allAgain.some((r) => r.id === todo.id));
  reopened.close();
  rmSync(join(path, '..'), { recursive: true, force: true });
});

test('structured-memory database delete removes a record', () => {
  const path = tmpDbPath();
  const db = new GoromboStructuredMemoryDatabase({ filePath: path });
  const todo = sampleTodo('2026-06-18T00:00:00.000Z');
  db.writeRecord(todo);
  assert.equal(db.getRecordById(todo.id)?.kind, 'todo');
  db.deleteRecord(todo.id);
  assert.equal(db.getRecordById(todo.id), null);
  db.close();
  rmSync(join(path, '..'), { recursive: true, force: true });
});

test('cleanupExpired archives completed todos older than retentionDays and hard-deletes aged archived records', () => {
  const path = tmpDbPath();
  const db = new GoromboStructuredMemoryDatabase({ filePath: path });
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  const veryOld = new Date(Date.now() - 400 * 86_400_000).toISOString();

  // Completed todo older than 30 days → should get archivedAt set.
  const agedTodo: Todo = {
    ...sampleTodo(old),
    status: 'completed',
    updatedAt: old,
  };
  db.writeRecord(agedTodo);

  // Record already archived long ago → should be hard-deleted by archiveDeleteDays=365.
  const archivedNote: SessionNote = {
    ...sampleNote(veryOld),
    status: 'archived',
    updatedAt: veryOld,
    archivedAt: veryOld,
  };
  db.writeRecord(archivedNote);

  const result = db.cleanupExpired(30, 365);
  assert.equal(result.archivedTodos, 1, 'completed todo aged past retention is archived');
  assert.equal(result.hardDeleted, 1, 'archived note older than archiveDeleteDays is deleted');

  const todoAfter = db.getRecordById(agedTodo.id) as Todo | null;
  assert.ok(todoAfter?.archivedAt, 'aged todo now carries archivedAt');
  assert.equal(db.getRecordById(archivedNote.id), null, 'old archived note hard-deleted');

  // retentionDays=0 disables the archive step; archiveDeleteDays=0 disables hard-delete.
  const freshTodo: Todo = { ...sampleTodo('2026-06-18T00:00:00.000Z'), status: 'completed' };
  db.writeRecord(freshTodo);
  const disabled = db.cleanupExpired(0, 0);
  assert.equal(disabled.archivedTodos, 0);
  assert.equal(disabled.hardDeleted, 0);
  assert.equal(db.getRecordById(freshTodo.id)?.kind, 'todo');

  db.close();
  rmSync(join(path, '..'), { recursive: true, force: true });
});
