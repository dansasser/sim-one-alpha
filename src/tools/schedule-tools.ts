/**
 * Orchestrator-owned schedule CRUD tools (plan §9).
 *
 * Exposed via `defineTool` from `@flue/runtime` and attached to the
 * orchestrator's `tools:` slot. Auth boundary (plan §2): `ownerScope` is
 * derived from the trusted `eventId` (the persisted chat ingress event), NEVER
 * model-selected. The model selects only the schedule fields (slug, kind,
 * schedule, prompt, targetAgent, tz, payload, deleteAfterRun). Mirrors the
 * `src/tools/memory-checklist-tools.ts` pattern.
 *
 * `targetAgent` semantics (see schedule-dispatch.ts + memory
 * `flue-agent-discovery-subagents`): only `orchestrator` is dispatchable;
 * `coding-worker` is delegated via the orchestrator's task tool. The model
 * picks the intended target; the manager records it and the dispatch always
 * goes to the orchestrator.
 */

import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

import { getScheduleManager } from '../schedules/boot.js';
import { scheduleInstanceId } from '../schedules/schedule-types.js';
import { getTrustedMemoryEvent } from './memory-tools-shared.js';

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

function deriveOwnerScope(eventId: string): string {
  const event = getTrustedMemoryEvent(eventId);
  return event.actor.id;
}

export const scheduleCreateTool = defineTool({
  name: 'schedule_create',
  description:
    'Create a recurring or one-shot scheduled agent turn. kind: "cron" (5-field cron expr), "every" (interval like "20m"/"1h"/"30s"/"3d"), or "at" (ISO 8601 one-shot timestamp). schedule: the cron expr / interval / ISO timestamp. prompt: the instruction sent to the agent each fire. targetAgent: "orchestrator" (default, handles inline) or "coding-worker" (orchestrator delegates to the coding-worker subagent). tz: IANA timezone (default UTC). deleteAfterRun: for "at" kind defaults true. ownerScope is derived from the trusted eventId; never pass it.',
  parameters: v.object({
    eventId: v.string(),
    slug: SlugSchema,
    kind: KindSchema,
    schedule: ScheduleExprSchema,
    prompt: PromptSchema,
    targetAgent: TargetAgentSchema,
    tz: v.optional(v.pipe(v.string(), v.minLength(1))),
    payload: v.optional(v.record(v.string(), v.unknown())),
    deleteAfterRun: v.optional(v.boolean()),
  }),
  execute: async ({ eventId, slug, kind, schedule, prompt, targetAgent, tz, payload, deleteAfterRun }) => {
    const manager = requireManager();
    const ownerScope = deriveOwnerScope(String(eventId));
    const record = manager.store.upsert({
      slug: String(slug),
      kind,
      schedule: String(schedule),
      prompt: String(prompt),
      ...(targetAgent ? { targetAgent } : {}),
      ...(tz ? { timezone: String(tz) } : {}),
      ...(payload ? { payload: payload as Record<string, unknown> } : {}),
      ...(deleteAfterRun !== undefined ? { deleteAfterRun } : {}),
      ownerScope,
    });
    manager.syncCron(record);
    return JSON.stringify({ schedule: { id: record.id, slug: record.slug, kind: record.kind, schedule: record.schedule, enabled: record.enabled, nextFireAt: record.nextFireAt } });
  },
});

export const schedulePauseTool = defineTool({
  name: 'schedule_pause',
  description: 'Pause a schedule (stop firing, keep the row).',
  parameters: v.object({
    eventId: v.string(),
    slug: SlugSchema,
  }),
  execute: async ({ eventId, slug }) => {
    void eventId;
    const manager = requireManager();
    const record = manager.store.setEnabled(String(slug), false);
    if (record) {
      manager.syncCron(record);
    }
    return JSON.stringify({ slug, paused: record !== null });
  },
});

export const scheduleResumeTool = defineTool({
  name: 'schedule_resume',
  description: 'Resume a paused schedule.',
  parameters: v.object({
    eventId: v.string(),
    slug: SlugSchema,
  }),
  execute: async ({ eventId, slug }) => {
    void eventId;
    const manager = requireManager();
    const record = manager.store.setEnabled(String(slug), true);
    if (record) {
      manager.syncCron(record);
    }
    return JSON.stringify({ slug, resumed: record !== null, nextFireAt: record?.nextFireAt ?? null });
  },
});

export const scheduleUpdateTool = defineTool({
  name: 'schedule_update',
  description: 'Update a schedule\'s schedule expression, prompt, payload, timezone, or enabled flag.',
  parameters: v.object({
    eventId: v.string(),
    slug: SlugSchema,
    schedule: v.optional(ScheduleExprSchema),
    prompt: v.optional(PromptSchema),
    payload: v.optional(v.record(v.string(), v.unknown())),
    tz: v.optional(v.pipe(v.string(), v.minLength(1))),
    enabled: v.optional(v.boolean()),
  }),
  execute: async ({ eventId, slug, schedule, prompt, payload, tz, enabled }) => {
    void eventId;
    const manager = requireManager();
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
});

export const scheduleDeleteTool = defineTool({
  name: 'schedule_delete',
  description: 'Delete a schedule and its run history.',
  parameters: v.object({
    eventId: v.string(),
    slug: SlugSchema,
  }),
  execute: async ({ eventId, slug }) => {
    void eventId;
    const manager = requireManager();
    const deleted = manager.store.delete(String(slug));
    return JSON.stringify({ slug, deleted });
  },
});

export const scheduleListTool = defineTool({
  name: 'schedule_list',
  description: 'List all schedules (compact rows: id, slug, kind, targetAgent, enabled, nextFireAt, lastFiredAt, lastRunStatus).',
  parameters: v.object({
    eventId: v.string(),
  }),
  execute: async ({ eventId }) => {
    void eventId;
    const manager = requireManager();
    return JSON.stringify({ schedules: manager.store.list() });
  },
});

export const scheduleGetTool = defineTool({
  name: 'schedule_get',
  description: 'Get the full definition of one schedule by slug.',
  parameters: v.object({
    eventId: v.string(),
    slug: SlugSchema,
  }),
  execute: async ({ eventId, slug }) => {
    void eventId;
    const manager = requireManager();
    const record = manager.store.getBySlug(String(slug));
    if (!record) {
      return JSON.stringify({ error: `schedule '${slug}' not found` });
    }
    return JSON.stringify({ schedule: record });
  },
});

export const scheduleRunNowTool = defineTool({
  name: 'schedule_run_now',
  description: 'Force-fire a schedule now (manual trigger). Returns the runId. The run goes through the same dispatch + observe path as a Croner-triggered fire.',
  parameters: v.object({
    eventId: v.string(),
    slug: SlugSchema,
  }),
  execute: async ({ eventId, slug }) => {
    void eventId;
    const manager = requireManager();
    const result = manager.fireNow(String(slug));
    if (!result) {
      return JSON.stringify({ error: `schedule '${slug}' not found` });
    }
    return JSON.stringify({ slug, runId: result.runId, instanceId: scheduleInstanceId(manager.store.getBySlug(String(slug))?.id ?? '', result.runId) });
  },
});

export const scheduleRunsTool = defineTool({
  name: 'schedule_runs',
  description: 'List recent run history for one schedule by slug.',
  parameters: v.object({
    eventId: v.string(),
    slug: SlugSchema,
    limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(500))),
  }),
  execute: async ({ eventId, slug, limit }) => {
    void eventId;
    const manager = requireManager();
    const record = manager.store.getBySlug(String(slug));
    if (!record) {
      return JSON.stringify({ error: `schedule '${slug}' not found` });
    }
    const runs = manager.store.listRuns(record.id, typeof limit === 'number' ? limit : 50);
    return JSON.stringify({ slug, runs });
  },
});