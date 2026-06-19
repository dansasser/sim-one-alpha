import { defineTool, type ToolDefinition } from '@flue/runtime';
import * as v from 'valibot';

import { renderChecklistTree } from '../../../types/memory.js';
import type { Checklist, ChecklistItem, MemoryRecordScope } from '../../../types/memory.js';
import type { MemoryEngine } from '../../../memory/memory-engine.js';
import type { CodingPlanItem } from '../types.js';
import { toRetrievedContext } from '../../../memory/checklist-memory-provider.js';
import type { CodingApprovalService } from '../approvals/approval-service.js';
import { recordCodingAuditEvent } from '../approvals/approval-service.js';
import { recordMemoryMutationEvent, type MemoryMutationEvent } from '../../../telemetry/flue-telemetry.js';
import {
  JsonFileCodingTaskRunStore,
  type CodingTaskRunStore,
} from '../session/task-run-store.js';

export interface CodingTaskMemoryToolsOptions {
  engineLoader: () => Promise<MemoryEngine>;
  /** Project scope injected from `CodingWorkspaceTargetInput.projectId`. The model cannot set this. */
  projectId?: string;
  /** Trusted scope identifiers (fail closed if none of projectId/projectSlug/projectRelativePath/repoPath is set). */
  projectSlug?: string;
  projectRelativePath?: string;
  repoPath?: string;
  workspaceRoot?: string;
  approvalService: CodingApprovalService;
  /** Optional task-run store for the plan->checklist handoff. */
  taskRunStore?: CodingTaskRunStore;
}

const SlugSchema = v.pipe(v.string(), v.minLength(1));
const TagsSchema = v.optional(v.array(v.pipe(v.string(), v.minLength(1))));
const ItemStatusSchema = v.picklist(['pending', 'in_progress', 'completed', 'blocked', 'skipped']);
const TodoStatusSchema = v.picklist(['pending', 'in_progress', 'completed', 'blocked', 'cancelled']);
const NoteImportanceSchema = v.picklist(['normal', 'high']);
const KindSchema = v.picklist(['checklist', 'todo', 'session_note']);

/**
 * Worker-local memory tool aliases. `projectId` is injected from the worker's
 * `CodingWorkspaceTargetInput`; the model cannot supply scope. Every mutating
 * write routes through `SharedCodingApprovalService` as an audit-only
 * `memory.write` event (Decision 4) - it is NOT in
 * `defaultApprovalRequiredActions` and is never gated on a human decision.
 */
export function createCodingTaskMemoryTools(options: CodingTaskMemoryToolsOptions): ToolDefinition[] {
  const scopeKey =
    options.projectId ??
    options.projectSlug ??
    options.projectRelativePath ??
    options.repoPath;
  const scope: MemoryRecordScope = { projectId: scopeKey };
  const audit = { updatedBy: 'coding-worker' };

  const auditWrite = (taskId: string, toolName: string, targetId: string, runId: string) =>
    recordCodingAuditEvent(options.approvalService, {
      taskId,
      actionType: 'memory.write',
      summary: `${toolName} -> ${targetId}`,
      target: targetId,
      metadata: {
        toolName,
        runId,
        agent: 'coding-worker',
        scopeProjectId: scope.projectId ?? '',
      },
    }).catch((error) => {
      console.error('[WARN] coding-worker memory audit failed:', error instanceof Error ? error.message : String(error));
    });

  const emit = (toolName: string, record: { id: string; kind: 'checklist' | 'todo' | 'session_note'; scope: MemoryRecordScope; updatedBy: string }, runId: string) => {
    const event: MemoryMutationEvent = {
      type: 'memory_mutation',
      timestamp: new Date().toISOString(),
      toolName,
      agentName: 'coding-worker',
      runId,
      recordId: record.id,
      kind: record.kind,
      scopeKeys: {
        ...(record.scope.actorId ? { actorId: record.scope.actorId } : {}),
        ...(record.scope.conversationId ? { conversationId: record.scope.conversationId } : {}),
        ...(record.scope.projectId ? { projectId: record.scope.projectId } : {}),
        ...(record.scope.threadId ? { threadId: record.scope.threadId } : {}),
        ...(record.scope.global ? { global: record.scope.global } : {}),
      },
      updatedBy: record.updatedBy,
    };
    try {
      recordMemoryMutationEvent(event);
    } catch {
      // best-effort telemetry
    }
  };

  return [
    defineTool({
      name: 'coding_task_create_checklist',
      description:
        'Create a project-scoped checklist for the current coding task. projectId is injected from the worker context; never pass scope.',
      parameters: v.object({
        taskId: v.pipe(v.string(), v.minLength(1)),
        title: v.pipe(v.string(), v.minLength(1)),
        slug: SlugSchema,
        description: v.optional(v.string()),
        tags: TagsSchema,
      }),
      execute: async ({ taskId, title, slug, description, tags }) => {
        const engine = await options.engineLoader();
        const checklist = await engine.createChecklist({
          title: String(title),
          slug: String(slug),
          ...(description !== undefined ? { description: String(description) } : {}),
          scope,
          ...(Array.isArray(tags) ? { tags } : {}),
          ...audit,
          runId: String(taskId),
        });
        await auditWrite(String(taskId), 'coding_task_create_checklist', checklist.id, String(taskId));
        emit('coding_task_create_checklist', checklist, String(taskId));
        return JSON.stringify({ checklist: renderChecklistTree(checklist) });
      },
    }),

    defineTool({
      name: 'coding_task_add_checklist_item',
      description: 'Add an item to a project-scoped checklist.',
      parameters: v.object({
        taskId: v.pipe(v.string(), v.minLength(1)),
        checklistId: v.pipe(v.string(), v.minLength(1)),
        parentId: v.optional(v.pipe(v.string(), v.minLength(1))),
        title: v.pipe(v.string(), v.minLength(1)),
        description: v.optional(v.string()),
        status: v.optional(ItemStatusSchema),
        ordinal: v.optional(v.number()),
        tags: TagsSchema,
        dueAt: v.optional(v.string()),
      }),
      execute: async ({ taskId, checklistId, parentId, title, description, status, ordinal, tags, dueAt }) => {
        const engine = await options.engineLoader();
        const checklist = await engine.addChecklistItem({
          checklistId: String(checklistId),
          ...(parentId !== undefined ? { parentId: String(parentId) } : {}),
          title: String(title),
          ...(description !== undefined ? { description: String(description) } : {}),
          ...(status !== undefined ? { status } : {}),
          ...(ordinal !== undefined ? { ordinal } : {}),
          ...(Array.isArray(tags) ? { tags } : {}),
          ...(dueAt !== undefined ? { dueAt: String(dueAt) } : {}),
          ...audit,
          runId: String(taskId),
        });
        emit('coding_task_add_checklist_item', checklist, String(taskId));
        await auditWrite(String(taskId), 'coding_task_add_checklist_item', checklist.id, String(taskId));
        emit('coding_task_add_checklist_item', checklist, String(taskId));
        return JSON.stringify({ checklist: renderChecklistTree(checklist) });
      },
    }),

    defineTool({
      name: 'coding_task_add_todo',
      description: 'Create a todo scoped to the current coding task/project.',
      parameters: v.object({
        taskId: v.pipe(v.string(), v.minLength(1)),
        title: v.pipe(v.string(), v.minLength(1)),
        description: v.optional(v.string()),
        priority: v.optional(v.picklist(['low', 'normal', 'high', 'urgent'])),
        tags: TagsSchema,
        dueAt: v.optional(v.string()),
      }),
      execute: async ({ taskId, title, description, priority, tags, dueAt }) => {
        const engine = await options.engineLoader();
        const todo = await engine.createTodo({
          title: String(title),
          ...(description !== undefined ? { description: String(description) } : {}),
          scope,
          ...(priority !== undefined ? { priority } : {}),
          ...(Array.isArray(tags) ? { tags } : {}),
          ...(dueAt !== undefined ? { dueAt: String(dueAt) } : {}),
          ...audit,
          runId: String(taskId),
        });
        await auditWrite(String(taskId), 'coding_task_add_todo', todo.id, String(taskId));
        emit('coding_task_add_todo', todo, String(taskId));
        return JSON.stringify({ todo });
      },
    }),

    defineTool({
      name: 'coding_task_complete_todo',
      description: 'Mark a coding-task todo completed.',
      parameters: v.object({
        taskId: v.pipe(v.string(), v.minLength(1)),
        id: v.pipe(v.string(), v.minLength(1)),
      }),
      execute: async ({ taskId, id }) => {
        const engine = await options.engineLoader();
        const todo = await engine.updateTodo({
          id: String(id),
          status: 'completed',
          ...audit,
          runId: String(taskId),
          expectedScope: scope,
        });
        await auditWrite(String(taskId), 'coding_task_complete_todo', todo.id, String(taskId));
        emit('coding_task_complete_todo', todo, String(taskId));
        return JSON.stringify({ todo });
      },
    }),

    defineTool({
      name: 'coding_task_store_note',
      description: 'Pin a decision/convention discovered during the coding run.',
      parameters: v.object({
        taskId: v.pipe(v.string(), v.minLength(1)),
        title: v.pipe(v.string(), v.minLength(1)),
        content: v.pipe(v.string(), v.minLength(1)),
        tags: TagsSchema,
        importance: v.optional(NoteImportanceSchema),
      }),
      execute: async ({ taskId, title, content, tags, importance }) => {
        const engine = await options.engineLoader();
        const note = await engine.createSessionNote({
          title: String(title),
          content: String(content),
          scope,
          ...(Array.isArray(tags) ? { tags } : {}),
          ...(importance !== undefined ? { importance } : {}),
          ...audit,
          runId: String(taskId),
        });
        await auditWrite(String(taskId), 'coding_task_store_note', note.id, String(taskId));
        emit('coding_task_store_note', note, String(taskId));
        return JSON.stringify({ note });
      },
    }),

    defineTool({
      name: 'coding_task_archive_note',
      description: 'Archive a coding-task session note.',
      parameters: v.object({
        taskId: v.pipe(v.string(), v.minLength(1)),
        id: v.pipe(v.string(), v.minLength(1)),
      }),
      execute: async ({ taskId, id }) => {
        const engine = await options.engineLoader();
        const note = await engine.updateSessionNote({
          id: String(id),
          status: 'archived',
          ...audit,
          runId: String(taskId),
          expectedScope: scope,
        });
        await auditWrite(String(taskId), 'coding_task_archive_note', note.id, String(taskId));
        emit('coding_task_archive_note', note, String(taskId));
        return JSON.stringify({ note });
      },
    }),

    defineTool({
      name: 'coding_task_search_memory',
      description: 'Keyword/tag search across project-scoped structured memory.',
      parameters: v.object({
        taskId: v.pipe(v.string(), v.minLength(1)),
        text: v.optional(v.string()),
        tags: TagsSchema,
        kinds: v.optional(v.array(KindSchema)),
        limit: v.optional(v.number()),
        includeArchived: v.optional(v.boolean()),
      }),
      execute: async ({ taskId: _taskId, text, tags, kinds, limit, includeArchived }) => {
        const engine = await options.engineLoader();
        const records = await engine.query({
          scope,
          ...(text !== undefined ? { text: String(text) } : {}),
          ...(Array.isArray(tags) ? { tags } : {}),
          ...(Array.isArray(kinds) ? { kinds } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(includeArchived !== undefined ? { includeArchived } : {}),
        });
        return JSON.stringify({ contexts: records.map(toRetrievedContext) });
      },
    }),

    defineTool({
      name: 'coding_task_handoff_plan_to_checklist',
      description:
        'Copy the plan items of a finished/blocked coding task run into a new durable checklist so the Memory Helper becomes the cross-run handoff (Decision 9).',
      parameters: v.object({
        taskId: v.pipe(v.string(), v.minLength(1)),
        sourceTaskId: v.pipe(v.string(), v.minLength(1)),
      }),
      execute: async ({ taskId, sourceTaskId }) => {
        const engine = await options.engineLoader();
        const store = options.taskRunStore ?? JsonFileCodingTaskRunStore.atWorkspaceRoot(options.workspaceRoot ?? process.cwd());
        const run = await store.get(String(sourceTaskId));
        if (!run) {
          throw new Error(`coding_task_handoff_plan_to_checklist: task run ${sourceTaskId} not found.`);
        }
        const items = planItemsToChecklistItems(run.plan);
        const checklist = await engine.createChecklist({
          title: `Handoff: ${sourceTaskId}`,
          slug: `handoff-${sourceTaskId}`.toLowerCase().replace(/[^a-z0-9._-]+/g, '-'),
          description: `Cross-run handoff from coding task ${sourceTaskId}.`,
          scope,
          tags: ['handoff'],
          items,
          ...audit,
          runId: String(taskId),
        });
        await recordCodingAuditEvent(options.approvalService, {
          taskId: String(taskId),
          actionType: 'memory.handoff',
          summary: `handoff plan -> checklist ${checklist.id}`,
          target: checklist.id,
          metadata: { sourceTaskId: String(sourceTaskId), runId: String(taskId), agent: 'coding-worker' },
        }).catch((error: unknown) => {
          console.error('[WARN] coding-worker handoff audit failed:', error instanceof Error ? error.message : String(error));
        });
        emit('coding_task_handoff_plan_to_checklist', checklist, String(taskId));
        return JSON.stringify({ checklist: renderChecklistTree(checklist) });
      },
    }),
  ];
}

function planItemsToChecklistItems(plan: CodingPlanItem[]): Array<Omit<ChecklistItem, 'id'>> {
  return plan.map((item, index) => ({
    title: item.description,
    status: planStatusToChecklistStatus(item.status),
    ordinal: index,
    tags: [item.owner],
  }));
}

function planStatusToChecklistStatus(status: CodingPlanItem['status']): ChecklistItem['status'] {
  switch (status) {
    case 'pending':
      return 'pending';
    case 'in_progress':
      return 'in_progress';
    case 'completed':
      return 'completed';
    case 'blocked':
      return 'blocked';
    default:
      return 'pending';
  }
}

export type CodingTaskMemoryToolName =
  | 'coding_task_create_checklist'
  | 'coding_task_add_checklist_item'
  | 'coding_task_add_todo'
  | 'coding_task_complete_todo'
  | 'coding_task_store_note'
  | 'coding_task_archive_note'
  | 'coding_task_search_memory'
  | 'coding_task_handoff_plan_to_checklist';
