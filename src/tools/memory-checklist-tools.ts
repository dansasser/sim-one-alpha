import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

import { renderChecklistTree } from '../types/memory.js';
import {
  deriveMemoryScope,
  emitMemoryMutation,
  getMemoryEngine,
  getTrustedMemoryEvent,
  orchestratorAudit,
} from './memory-tools-shared.js';

const SlugSchema = v.pipe(v.string(), v.minLength(1));
const TagsSchema = v.optional(v.array(v.pipe(v.string(), v.minLength(1))));
const ItemStatusSchema = v.picklist(['pending', 'in_progress', 'completed', 'blocked', 'skipped']);
const ChecklistStatusSchema = v.picklist(['active', 'archived']);

const InitialItemSchema = v.object({
  title: v.pipe(v.string(), v.minLength(1)),
  description: v.optional(v.string()),
  status: v.optional(ItemStatusSchema),
  ordinal: v.optional(v.number()),
  tags: TagsSchema,
  dueAt: v.optional(v.string()),
  parentId: v.optional(v.pipe(v.string(), v.minLength(1))),
});

export const createChecklistTool = defineTool({
  name: 'create_checklist',
  description:
    'Create a structured-memory checklist for the current scope (actor/conversation/project). Items may be nested via parentId up to the configured max depth. Scope is derived from the trusted eventId; never pass scope.',
  parameters: v.object({
    eventId: v.string(),
    title: v.pipe(v.string(), v.minLength(1)),
    slug: SlugSchema,
    description: v.optional(v.string()),
    tags: TagsSchema,
    items: v.optional(v.array(InitialItemSchema)),
  }),
  execute: async ({ eventId, title, slug, description, tags, items }) => {
    const event = getTrustedMemoryEvent(eventId);
    const engine = await getMemoryEngine();
    const checklist = await engine.createChecklist({
      title: String(title),
      slug: String(slug),
      ...(description !== undefined ? { description: String(description) } : {}),
      scope: deriveMemoryScope(event),
      ...(Array.isArray(tags) ? { tags } : {}),
      ...(Array.isArray(items) ? { items } : {}),
      ...orchestratorAudit(),
    });
    emitMemoryMutation('create_checklist', 'orchestrator', checklist);
    return JSON.stringify({ checklist: renderChecklistTree(checklist) });
  },
});

export const updateChecklistTool = defineTool({
  name: 'update_checklist',
  description:
    'Update a checklist (rename, re-slug, archive, replace tags). Use archive_checklist to archive. Scope is derived from the trusted eventId.',
  parameters: v.object({
    eventId: v.string(),
    id: v.pipe(v.string(), v.minLength(1)),
    title: v.optional(v.pipe(v.string(), v.minLength(1))),
    slug: v.optional(SlugSchema),
    description: v.optional(v.string()),
    tags: TagsSchema,
    status: v.optional(ChecklistStatusSchema),
  }),
  execute: async ({ eventId, id, title, slug, description, tags, status }) => {
    const event = getTrustedMemoryEvent(eventId);
    const engine = await getMemoryEngine();
    const checklist = await engine.updateChecklist({
      id: String(id),
      ...(title !== undefined ? { title: String(title) } : {}),
      ...(slug !== undefined ? { slug: String(slug) } : {}),
      ...(description !== undefined ? { description: String(description) } : {}),
      ...(Array.isArray(tags) ? { tags } : {}),
      ...(status !== undefined ? { status } : {}),
      ...orchestratorAudit(),
      expectedScope: deriveMemoryScope(event),
    });
    emitMemoryMutation('update_checklist', 'orchestrator', checklist);
    return JSON.stringify({ checklist: renderChecklistTree(checklist) });
  },
});

export const addChecklistItemTool = defineTool({
  name: 'add_checklist_item',
  description:
    'Add an item to a checklist. parentId attaches it under an existing item (nesting bounded by max depth). Scope is derived from the trusted eventId.',
  parameters: v.object({
    eventId: v.string(),
    checklistId: v.pipe(v.string(), v.minLength(1)),
    parentId: v.optional(v.pipe(v.string(), v.minLength(1))),
    title: v.pipe(v.string(), v.minLength(1)),
    description: v.optional(v.string()),
    status: v.optional(ItemStatusSchema),
    ordinal: v.optional(v.number()),
    tags: TagsSchema,
    dueAt: v.optional(v.string()),
  }),
  execute: async ({ eventId, checklistId, parentId, title, description, status, ordinal, tags, dueAt }) => {
    const event = getTrustedMemoryEvent(eventId);
    const engine = await getMemoryEngine();
    const checklist = await engine.addChecklistItem({
      checklistId: String(checklistId),
      ...(parentId !== undefined ? { parentId: String(parentId) } : {}),
      title: String(title),
      ...(description !== undefined ? { description: String(description) } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(ordinal !== undefined ? { ordinal } : {}),
      ...(Array.isArray(tags) ? { tags } : {}),
      ...(dueAt !== undefined ? { dueAt: String(dueAt) } : {}),
      ...orchestratorAudit(),
      expectedScope: deriveMemoryScope(event),
    });
    emitMemoryMutation('add_checklist_item', 'orchestrator', checklist);
    return JSON.stringify({ checklist: renderChecklistTree(checklist) });
  },
});

export const updateChecklistItemTool = defineTool({
  name: 'update_checklist_item',
  description:
    'Update a checklist item (title, status, description, tags, due/completed dates). Scope is derived from the trusted eventId.',
  parameters: v.object({
    eventId: v.string(),
    checklistId: v.pipe(v.string(), v.minLength(1)),
    itemId: v.pipe(v.string(), v.minLength(1)),
    title: v.optional(v.pipe(v.string(), v.minLength(1))),
    description: v.optional(v.string()),
    status: v.optional(ItemStatusSchema),
    ordinal: v.optional(v.number()),
    tags: TagsSchema,
    dueAt: v.optional(v.string()),
    completedAt: v.optional(v.string()),
  }),
  execute: async ({ eventId, checklistId, itemId, title, description, status, ordinal, tags, dueAt, completedAt }) => {
    const event = getTrustedMemoryEvent(eventId);
    const engine = await getMemoryEngine();
    const checklist = await engine.updateChecklistItem({
      checklistId: String(checklistId),
      itemId: String(itemId),
      ...(title !== undefined ? { title: String(title) } : {}),
      ...(description !== undefined ? { description: String(description) } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(ordinal !== undefined ? { ordinal } : {}),
      ...(Array.isArray(tags) ? { tags } : {}),
      ...(dueAt !== undefined ? { dueAt: String(dueAt) } : {}),
      ...(completedAt !== undefined ? { completedAt: String(completedAt) } : {}),
      ...orchestratorAudit(),
      expectedScope: deriveMemoryScope(event),
    });
    emitMemoryMutation('update_checklist_item', 'orchestrator', checklist);
    return JSON.stringify({ checklist: renderChecklistTree(checklist) });
  },
});

export const moveChecklistItemTool = defineTool({
  name: 'move_checklist_item',
  description:
    'Move a checklist item under a new parent and/or reorder it (ordinal). Pass parentId as empty/omit to move to top level. Scope is derived from the trusted eventId.',
  parameters: v.object({
    eventId: v.string(),
    checklistId: v.pipe(v.string(), v.minLength(1)),
    itemId: v.pipe(v.string(), v.minLength(1)),
    parentId: v.optional(v.string()),
    ordinal: v.optional(v.number()),
  }),
  execute: async ({ eventId, checklistId, itemId, parentId, ordinal }) => {
    const event = getTrustedMemoryEvent(eventId);
    const engine = await getMemoryEngine();
    const checklist = await engine.updateChecklistItem({
      checklistId: String(checklistId),
      itemId: String(itemId),
      ...(parentId !== undefined ? { parentId: parentId || undefined } : {}),
      ...(ordinal !== undefined ? { ordinal } : {}),
      ...orchestratorAudit(),
      expectedScope: deriveMemoryScope(event),
    });
    emitMemoryMutation('move_checklist_item', 'orchestrator', checklist);
    return JSON.stringify({ checklist: renderChecklistTree(checklist) });
  },
});

export const archiveChecklistTool = defineTool({
  name: 'archive_checklist',
  description: 'Archive a checklist (status -> archived). Scope is derived from the trusted eventId.',
  parameters: v.object({
    eventId: v.string(),
    id: v.pipe(v.string(), v.minLength(1)),
  }),
  execute: async ({ eventId, id }) => {
    const event = getTrustedMemoryEvent(eventId);
    const engine = await getMemoryEngine();
    const checklist = await engine.updateChecklist({
      id: String(id),
      status: 'archived',
      ...orchestratorAudit(),
      expectedScope: deriveMemoryScope(event),
    });
    emitMemoryMutation('archive_checklist', 'orchestrator', checklist);
    return JSON.stringify({ checklist: renderChecklistTree(checklist) });
  },
});

export const listChecklistsTool = defineTool({
  name: 'list_checklists',
  description:
    'List active checklists for the current scope. Scope is derived from the trusted eventId.',
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
      kinds: ['checklist'],
      ...(limit !== undefined ? { limit } : {}),
      ...(includeArchived !== undefined ? { includeArchived } : {}),
    });
    const checklists = records
      .filter((r): r is import('../types/memory.js').Checklist => r.kind === 'checklist')
      .map(renderChecklistTree);
    return JSON.stringify({ checklists });
  },
});
