import assert from 'node:assert/strict';
import test from 'node:test';

import {
  completeTodoTool,
  createTodoTool,
  listTodosTool,
  updateTodoTool,
} from '../tools/memory-todo-tools.js';
import { setupMemoryToolTest } from './helpers/memory-tool-test-setup.js';

test('todo tools create/complete/list through the trusted event scope', async () => {
  const { event, cleanup } = await setupMemoryToolTest({ projectId: 'proj-todo' });
  try {
    const created = JSON.parse(
      await createTodoTool.execute({ eventId: event.id, title: 'Run smoke', priority: 'high' }),
    ) as { todo: { id: string; status: string; priority: string } };
    assert.equal(created.todo.status, 'pending');
    assert.equal(created.todo.priority, 'high');

    const completed = JSON.parse(
      await completeTodoTool.execute({ eventId: event.id, id: created.todo.id }),
    ) as { todo: { status: string; completedAt?: string } };
    assert.equal(completed.todo.status, 'completed');
    assert.ok(completed.todo.completedAt);

    // A freshly completed todo is soft-retained (no archivedAt yet), so it is
    // still visible in default retrieval until the cold-start cleanup archives
    // it past retentionDays (Decision 3).
    const active = JSON.parse(await listTodosTool.execute({ eventId: event.id })) as {
      todos: { id: string }[];
    };
    assert.ok(active.todos.some((t) => t.id === created.todo.id), 'completed todo is soft-retained and visible');
  } finally {
    cleanup();
  }
});

test('update_todo changes priority', async () => {
  const { event, cleanup } = await setupMemoryToolTest({ projectId: 'proj-todo2' });
  try {
    const created = JSON.parse(
      await createTodoTool.execute({ eventId: event.id, title: 'T' }),
    ) as { todo: { id: string } };
    const updated = JSON.parse(
      await updateTodoTool.execute({ eventId: event.id, id: created.todo.id, priority: 'urgent' }),
    ) as { todo: { priority: string } };
    assert.equal(updated.todo.priority, 'urgent');
  } finally {
    cleanup();
  }
});
