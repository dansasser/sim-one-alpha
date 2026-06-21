import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

import { toRetrievedContext } from '../memory/checklist-memory-provider.js';
import {
  deriveMemoryScope,
  getMemoryEngine,
  getTrustedMemoryEvent,
} from './memory-tools-shared.js';

const TagsSchema = v.optional(v.array(v.pipe(v.string(), v.minLength(1))));
const KindSchema = v.picklist(['checklist', 'todo', 'session_note']);

export const searchMemoryRecordsTool = defineTool({
  name: 'search_memory_records',
  description:
    'Keyword/tag search across structured memory (checklists, todos, session notes) for the current scope. Returns RetrievedContext records with provider "structured-memory". Scope is derived from the trusted eventId.',
  parameters: v.object({
    eventId: v.string(),
    text: v.optional(v.string()),
    tags: TagsSchema,
    kinds: v.optional(v.array(KindSchema)),
    limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
    includeArchived: v.optional(v.boolean()),
  }),
  execute: async ({ eventId, text, tags, kinds, limit, includeArchived }) => {
    const event = getTrustedMemoryEvent(eventId);
    const engine = await getMemoryEngine();
    const records = await engine.query({
      scope: deriveMemoryScope(event),
      ...(text !== undefined ? { text: String(text) } : {}),
      ...(Array.isArray(tags) ? { tags } : {}),
      ...(Array.isArray(kinds) ? { kinds } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(includeArchived !== undefined ? { includeArchived } : {}),
    });
    const contexts = records.map(toRetrievedContext);
    return JSON.stringify({ contexts });
  },
});
