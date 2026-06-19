import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

import {
  deriveMemoryScope,
  emitMemoryMutation,
  getMemoryEngine,
  getTrustedMemoryEvent,
  orchestratorAudit,
} from './memory-tools-shared.js';

const TagsSchema = v.optional(v.array(v.pipe(v.string(), v.minLength(1))));
const TodoStatusSchema = v.picklist(['pending', 'in_progress', 'completed', 'blocked', 'cancelled']);
const TodoPrioritySchema = v.picklist(['low', 'normal', 'high', 'urgent']);

export const createTodoTool = defineTool({
  name: 'create_todo',
  description:
    'Create a standalone todo for the current scope. Scope is derived from the trusted eventId; never pass scope.',
  parameters: v.object({
    eventId: v.string(),
    title: v.pipe(v.string(), v.minLength(1)),
    slug: v.optional(v.pipe(v.string(), v.minLength(1))),
    description: v.optional(v.string()),
    priority: v.optional(TodoPrioritySchema),
    tags: TagsSchema,
    dueAt: v.optional(v.string()),
  }),
  execute: async ({ eventId, title, slug, description, priority, tags, dueAt }) => {
    const event = getTrustedMemoryEvent(eventId);
    const engine = await getMemoryEngine();
    const todo = await engine.createTodo({
      title: String(title),
      ...(slug !== undefined ? { slug: String(slug) } : {}),
      ...(description !== undefined ? { description: String(description) } : {}),
      scope: deriveMemoryScope(event),
      ...(priority !== undefined ? { priority } : {}),
      ...(Array.isArray(tags) ? { tags } : {}),
      ...(dueAt !== undefined ? { dueAt: String(dueAt) } : {}),
      ...orchestratorAudit(),
    });
    return JSON.stringify({ todo });
  },
});

export const updateTodoTool = defineTool({
  name: 'update_todo',
  description:
    'Update a todo (title, priority, status, tags, due date). Scope is derived from the trusted eventId.',
  parameters: v.object({
    eventId: v.string(),
    id: v.pipe(v.string(), v.minLength(1)),
    title: v.optional(v.pipe(v.string(), v.minLength(1))),
    description: v.optional(v.string()),
    priority: v.optional(TodoPrioritySchema),
    status: v.optional(TodoStatusSchema),
    tags: TagsSchema,
    dueAt: v.optional(v.string()),
  }),
  execute: async ({ eventId, id, title, description, priority, status, tags, dueAt }) => {
    const event = getTrustedMemoryEvent(eventId);
    const engine = await getMemoryEngine();
    const todo = await engine.updateTodo({
      id: String(id),
      ...(title !== undefined ? { title: String(title) } : {}),
      ...(description !== undefined ? { description: String(description) } : {}),
      ...(priority !== undefined ? { priority } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(Array.isArray(tags) ? { tags } : {}),
      ...(dueAt !== undefined ? { dueAt: String(dueAt) } : {}),
      ...orchestratorAudit(),
      expectedScope: deriveMemoryScope(event),
    });
    return JSON.stringify({ todo });
  },
});

export const completeTodoTool = defineTool({
  name: 'complete_todo',
  description: 'Mark a todo completed. Scope is derived from the trusted eventId.',
  parameters: v.object({
    eventId: v.string(),
    id: v.pipe(v.string(), v.minLength(1)),
  }),
  execute: async ({ eventId, id }) => {
    const event = getTrustedMemoryEvent(eventId);
    const engine = await getMemoryEngine();
    const todo = await engine.updateTodo({
      id: String(id),
      status: 'completed',
      ...orchestratorAudit(),
      expectedScope: deriveMemoryScope(event),
    });
    return JSON.stringify({ todo });
  },
});

export const cancelTodoTool = defineTool({
  name: 'cancel_todo',
  description: 'Cancel a todo (status -> cancelled). Scope is derived from the trusted eventId.',
  parameters: v.object({
    eventId: v.string(),
    id: v.pipe(v.string(), v.minLength(1)),
  }),
  execute: async ({ eventId, id }) => {
    const event = getTrustedMemoryEvent(eventId);
    const engine = await getMemoryEngine();
    const todo = await engine.updateTodo({
      id: String(id),
      status: 'cancelled',
      ...orchestratorAudit(),
      expectedScope: deriveMemoryScope(event),
    });
    return JSON.stringify({ todo });
  },
});

export const listTodosTool = defineTool({
  name: 'list_todos',
  description:
    'List active todos for the current scope. Scope is derived from the trusted eventId.',
  parameters: v.object({
    eventId: v.string(),
    limit: v.optional(v.number()),
    includeArchived: v.optional(v.boolean()),
  }),
  execute: async ({ eventId, limit, includeArchived }) => {
    const event = getTrustedMemoryEvent(eventId);
    const engine = await getMemoryEngine();
    const records = await engine.query({
      scope: deriveMemoryScope(event),
      kinds: ['todo'],
      ...(limit !== undefined ? { limit } : {}),
      ...(includeArchived !== undefined ? { includeArchived } : {}),
    });
    const todos = records.filter((r): r is import('../types/memory.js').Todo => r.kind === 'todo');
    return JSON.stringify({ todos });
  },
});
