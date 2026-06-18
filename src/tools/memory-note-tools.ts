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
const NoteStatusSchema = v.picklist(['active', 'archived']);
const NoteImportanceSchema = v.picklist(['normal', 'high']);

export const storeSessionNoteTool = defineTool({
  name: 'store_session_note',
  description:
    'Pin a session note (a fact/reminder) for the current scope. Scope is derived from the trusted eventId; never pass scope.',
  parameters: v.object({
    eventId: v.string(),
    title: v.pipe(v.string(), v.minLength(1)),
    content: v.pipe(v.string(), v.minLength(1)),
    tags: TagsSchema,
    importance: v.optional(NoteImportanceSchema),
  }),
  execute: async ({ eventId, title, content, tags, importance }) => {
    const event = getTrustedMemoryEvent(eventId);
    const engine = await getMemoryEngine();
    const note = await engine.createSessionNote({
      title: String(title),
      content: String(content),
      scope: deriveMemoryScope(event),
      ...(Array.isArray(tags) ? { tags } : {}),
      ...(importance !== undefined ? { importance } : {}),
      ...orchestratorAudit(),
    });
    emitMemoryMutation('store_session_note', 'orchestrator', note);
    emitMemoryMutation('update_session_note', 'orchestrator', note);
    emitMemoryMutation('archive_session_note', 'orchestrator', note);
    return JSON.stringify({ note });
  },
});

export const updateSessionNoteTool = defineTool({
  name: 'update_session_note',
  description:
    'Update a session note (title, content, tags, importance, status). Scope is derived from the trusted eventId.',
  parameters: v.object({
    eventId: v.string(),
    id: v.pipe(v.string(), v.minLength(1)),
    title: v.optional(v.pipe(v.string(), v.minLength(1))),
    content: v.optional(v.string()),
    tags: TagsSchema,
    status: v.optional(NoteStatusSchema),
    importance: v.optional(NoteImportanceSchema),
  }),
  execute: async ({ eventId, id, title, content, tags, status, importance }) => {
    getTrustedMemoryEvent(eventId);
    const engine = await getMemoryEngine();
    const note = await engine.updateSessionNote({
      id: String(id),
      ...(title !== undefined ? { title: String(title) } : {}),
      ...(content !== undefined ? { content: String(content) } : {}),
      ...(Array.isArray(tags) ? { tags } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(importance !== undefined ? { importance } : {}),
      ...orchestratorAudit(),
    });
    return JSON.stringify({ note });
  },
});

export const archiveSessionNoteTool = defineTool({
  name: 'archive_session_note',
  description: 'Archive a session note (status -> archived). Scope is derived from the trusted eventId.',
  parameters: v.object({
    eventId: v.string(),
    id: v.pipe(v.string(), v.minLength(1)),
  }),
  execute: async ({ eventId, id }) => {
    getTrustedMemoryEvent(eventId);
    const engine = await getMemoryEngine();
    const note = await engine.updateSessionNote({
      id: String(id),
      status: 'archived',
      ...orchestratorAudit(),
    });
    return JSON.stringify({ note });
  },
});

export const listSessionNotesTool = defineTool({
  name: 'list_session_notes',
  description:
    'List active session notes for the current scope. Scope is derived from the trusted eventId.',
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
      kinds: ['session_note'],
      ...(limit !== undefined ? { limit } : {}),
      ...(includeArchived !== undefined ? { includeArchived } : {}),
    });
    const notes = records.filter(
      (r): r is import('../types/memory.js').SessionNote => r.kind === 'session_note',
    );
    return JSON.stringify({ notes });
  },
});
