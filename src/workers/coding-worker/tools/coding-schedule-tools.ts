/**
 * Coding-worker-local schedule tool aliases (plan §9, §15).
 *
 * `coding_schedule_*` aliases of the orchestrator schedule tools, scoped to the
 * coding-worker's `projectId` (injected from the worker context — the model
 * cannot supply scope, mirroring `coding_task_*` memory-tool aliasing). These
 * are LEAD-ONLY: attached to the coding-worker lead's `tools:` slot only;
 * internal coding subagents (triage, implementer, test-debug, code-review,
 * github) never see them (AGENTS.md: internal subagents must not be exposed).
 *
 * `targetAgent` defaults to `'coding-worker'` (the worker scheduling its own
 * long-running loops). Per the Flue agent-discovery constraint (see
 * `schedule-dispatch.ts`), the fire still dispatches to the orchestrator, which
 * delegates to the coding-worker subagent via its task tool. Mutating repo side
 * effects inside a scheduled coding-worker run still go through the existing
 * `SharedCodingApprovalService` fail-closed boundary — scheduling does NOT
 * bypass approvals (plan §15).
 */

import { defineTool, type ToolDefinition } from '@flue/runtime';
import * as v from 'valibot';

import { getScheduleManager } from '../../../schedules/boot.js';
import { scheduleInstanceId } from '../../../schedules/schedule-types.js';

export interface CodingScheduleToolsOptions {
  /** Project scope injected from CodingWorkspaceTargetInput.projectId. The model cannot set this. */
  projectId?: string;
}

const SlugSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(128));
const KindSchema = v.picklist(['cron', 'every', 'at']);
const TargetAgentSchema = v.optional(v.picklist(['orchestrator', 'coding-worker']));
const PromptSchema = v.pipe(v.string(), v.minLength(1));
const ScheduleExprSchema = v.pipe(v.string(), v.minLength(1));

function requireManager() {
  const manager = getScheduleManager();
  if (!manager) {
    throw new Error('Schedules are not enabled on this server.');
  }
  return manager;
}

/** Fail closed if no trusted project scope was injected by the worker context. */
function requireTrustedScope(projectId: string | undefined): string {
  if (!projectId) {
    throw new Error(
      'coding-worker schedule tools require a trusted project scope (projectId); none was provided by the worker context.',
    );
  }
  return projectId;
}

export function createCodingScheduleTools(options: CodingScheduleToolsOptions): ToolDefinition[] {
  const ownerScope = options.projectId;

  return [
    defineTool({
      name: 'coding_schedule_create',
      description:
        'Create a recurring or one-shot scheduled coding-worker loop. kind: "cron"|"every"|"at". schedule: cron expr / interval (e.g. "20m") / ISO 8601 timestamp. prompt: the loop-step instruction. targetAgent defaults to "coding-worker" (orchestrator delegates to the coding-worker subagent). Scope (projectId) is injected from the worker context; never pass it. Mutating repo side effects inside a scheduled run still require approval.',
      parameters: v.object({
        slug: SlugSchema,
        kind: KindSchema,
        schedule: ScheduleExprSchema,
        prompt: PromptSchema,
        targetAgent: TargetAgentSchema,
        tz: v.optional(v.pipe(v.string(), v.minLength(1))),
        payload: v.optional(v.record(v.string(), v.unknown())),
        deleteAfterRun: v.optional(v.boolean()),
      }),
      execute: async ({ slug, kind, schedule, prompt, targetAgent, tz, payload, deleteAfterRun }) => {
        const manager = requireManager();
        const scope = requireTrustedScope(ownerScope);
        const record = manager.store.upsert({
          slug: String(slug),
          kind,
          schedule: String(schedule),
          prompt: String(prompt),
          targetAgent: targetAgent ?? 'coding-worker',
          ...(tz ? { timezone: String(tz) } : {}),
          ...(payload ? { payload: payload as Record<string, unknown> } : {}),
          ...(deleteAfterRun !== undefined ? { deleteAfterRun } : {}),
          ownerScope: scope,
        });
        manager.syncCron(record);
        return JSON.stringify({ schedule: { id: record.id, slug: record.slug, kind: record.kind, schedule: record.schedule, enabled: record.enabled, nextFireAt: record.nextFireAt } });
      },
    }),
    defineTool({
      name: 'coding_schedule_pause',
      description: 'Pause a coding-worker schedule.',
      parameters: v.object({ slug: SlugSchema }),
      execute: async ({ slug }) => {
        const manager = requireManager();
        requireTrustedScope(ownerScope);
        const record = manager.store.setEnabled(String(slug), false);
        if (record) {
          manager.syncCron(record);
        }
        return JSON.stringify({ slug, paused: record !== null });
      },
    }),
    defineTool({
      name: 'coding_schedule_resume',
      description: 'Resume a paused coding-worker schedule.',
      parameters: v.object({ slug: SlugSchema }),
      execute: async ({ slug }) => {
        const manager = requireManager();
        requireTrustedScope(ownerScope);
        const record = manager.store.setEnabled(String(slug), true);
        if (record) {
          manager.syncCron(record);
        }
        return JSON.stringify({ slug, resumed: record !== null, nextFireAt: record?.nextFireAt ?? null });
      },
    }),
    defineTool({
      name: 'coding_schedule_update',
      description: 'Update a coding-worker schedule\'s expression, prompt, payload, timezone, or enabled flag.',
      parameters: v.object({
        slug: SlugSchema,
        schedule: v.optional(ScheduleExprSchema),
        prompt: v.optional(PromptSchema),
        payload: v.optional(v.record(v.string(), v.unknown())),
        tz: v.optional(v.pipe(v.string(), v.minLength(1))),
        enabled: v.optional(v.boolean()),
      }),
      execute: async ({ slug, schedule, prompt, payload, tz, enabled }) => {
        const manager = requireManager();
        requireTrustedScope(ownerScope);
        const record = manager.store.updateFields(String(slug), {
          ...(schedule !== undefined ? { schedule: String(schedule) } : {}),
          ...(prompt !== undefined ? { prompt: String(prompt) } : {}),
          ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
          ...(tz !== undefined ? { timezone: String(tz) } : {}),
          ...(enabled !== undefined ? { enabled } : {}),
        });
        if (record) {
          manager.syncCron(record);
        }
        return JSON.stringify({ slug, updated: record !== null, nextFireAt: record?.nextFireAt ?? null });
      },
    }),
    defineTool({
      name: 'coding_schedule_delete',
      description: 'Delete a coding-worker schedule and its run history.',
      parameters: v.object({ slug: SlugSchema }),
      execute: async ({ slug }) => {
        const manager = requireManager();
        requireTrustedScope(ownerScope);
        const deleted = manager.store.delete(String(slug));
        return JSON.stringify({ slug, deleted });
      },
    }),
    defineTool({
      name: 'coding_schedule_list',
      description: 'List all schedules (compact rows).',
      parameters: v.object({}),
      execute: async () => {
        const manager = requireManager();
        requireTrustedScope(ownerScope);
        return JSON.stringify({ schedules: manager.store.list() });
      },
    }),
    defineTool({
      name: 'coding_schedule_get',
      description: 'Get the full definition of one coding-worker schedule by slug.',
      parameters: v.object({ slug: SlugSchema }),
      execute: async ({ slug }) => {
        const manager = requireManager();
        requireTrustedScope(ownerScope);
        const record = manager.store.getBySlug(String(slug));
        if (!record) {
          return JSON.stringify({ error: `schedule '${slug}' not found` });
        }
        return JSON.stringify({ schedule: record });
      },
    }),
    defineTool({
      name: 'coding_schedule_run_now',
      description: 'Force-fire a coding-worker schedule now. Returns the runId.',
      parameters: v.object({ slug: SlugSchema }),
      execute: async ({ slug }) => {
        const manager = requireManager();
        requireTrustedScope(ownerScope);
        const result = manager.fireNow(String(slug));
        if (!result) {
          return JSON.stringify({ error: `schedule '${slug}' not found` });
        }
        return JSON.stringify({ slug, runId: result.runId, instanceId: scheduleInstanceId(manager.store.getBySlug(String(slug))?.id ?? '', result.runId) });
      },
    }),
    defineTool({
      name: 'coding_schedule_runs',
      description: 'List recent run history for one coding-worker schedule by slug.',
      parameters: v.object({
        slug: SlugSchema,
        limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(500))),
      }),
      execute: async ({ slug, limit }) => {
        const manager = requireManager();
        requireTrustedScope(ownerScope);
        const record = manager.store.getBySlug(String(slug));
        if (!record) {
          return JSON.stringify({ error: `schedule '${slug}' not found` });
        }
        const runs = manager.store.listRuns(record.id, typeof limit === 'number' ? limit : 50);
        return JSON.stringify({ slug, runs });
      },
    }),
  ];
}