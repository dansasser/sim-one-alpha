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
import { loadOwnedSchedule } from '../schedules/schedule-ownership.js';
import { emitScheduleProgress } from '../schedules/schedule-telemetry.js';
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
    emitScheduleProgress('schedule.created', { scheduleId: record.id, slug: record.slug, ownerScope });
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
    const manager = requireManager();
    const ownerScope = deriveOwnerScope(String(eventId));
    const owned = loadOwnedSchedule(manager.store, String(slug), ownerScope);
    if (!owned.ok) {
      return JSON.stringify({ slug, error: owned.error });
    }
    const record = manager.store.setEnabled(String(slug), false);
    if (record) {
      manager.syncCron(record);
      emitScheduleProgress('schedule.paused', { scheduleId: record.id, slug: record.slug });
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
    const manager = requireManager();
    const ownerScope = deriveOwnerScope(String(eventId));
    const owned = loadOwnedSchedule(manager.store, String(slug), ownerScope);
    if (!owned.ok) {
      return JSON.stringify({ slug, error: owned.error });
    }
    const record = manager.store.setEnabled(String(slug), true);
    if (record) {
      manager.syncCron(record);
      emitScheduleProgress('schedule.resumed', { scheduleId: record.id, slug: record.slug });
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
    const manager = requireManager();
    const ownerScope = deriveOwnerScope(String(eventId));
    const owned = loadOwnedSchedule(manager.store, String(slug), ownerScope);
    if (!owned.ok) {
      return JSON.stringify({ slug, error: owned.error });
    }
    const record = manager.store.updateFields(String(slug), {
      ...(schedule !== undefined ? { schedule: String(schedule) } : {}),
      ...(prompt !== undefined ? { prompt: String(prompt) } : {}),
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
      ...(tz !== undefined ? { timezone: String(tz) } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
    });
    if (record) {
      manager.syncCron(record);
      emitScheduleProgress('schedule.updated', { scheduleId: record.id, slug: record.slug });
    }
    return JSON.stringify({ slug, updated: record !== null, nextFireAt: record?.nextFireAt ?? null });
  },
});

export const scheduleDeleteTool = defineTool({
  name: 'schedule_delete',
  description: 'Delete a schedule and its run history. Stops the in-memory Croner job immediately.',
  parameters: v.object({
    eventId: v.string(),
    slug: SlugSchema,
  }),
  execute: async ({ eventId, slug }) => {
    const manager = requireManager();
    const ownerScope = deriveOwnerScope(String(eventId));
    const owned = loadOwnedSchedule(manager.store, String(slug), ownerScope);
    if (!owned.ok) {
      return JSON.stringify({ slug, error: owned.error });
    }
    const deleted = manager.deleteSchedule(String(slug));
    return JSON.stringify({ slug, deleted });
  },
});

export const scheduleListTool = defineTool({
  name: 'schedule_list',
  description: 'List schedules owned by the current actor (compact rows: id, slug, kind, targetAgent, enabled, nextFireAt, lastFiredAt, lastRunStatus). ownerScope is derived from the trusted eventId.',
  parameters: v.object({
    eventId: v.string(),
  }),
  execute: async ({ eventId }) => {
    const manager = requireManager();
    const ownerScope = deriveOwnerScope(String(eventId));
    return JSON.stringify({ schedules: manager.store.listForOwner(ownerScope) });
  },
});

export const scheduleGetTool = defineTool({
  name: 'schedule_get',
  description: 'Get the full definition of one schedule by slug (must be owned by the current actor).',
  parameters: v.object({
    eventId: v.string(),
    slug: SlugSchema,
  }),
  execute: async ({ eventId, slug }) => {
    const manager = requireManager();
    const ownerScope = deriveOwnerScope(String(eventId));
    const owned = loadOwnedSchedule(manager.store, String(slug), ownerScope);
    if (!owned.ok) {
      return JSON.stringify({ error: owned.error });
    }
    return JSON.stringify({ schedule: owned.record });
  },
});

export const scheduleRunNowTool = defineTool({
  name: 'schedule_run_now',
  description: 'Force-fire a schedule now (manual trigger). Returns the runId. The run goes through the same dispatch + observe path as a Croner-triggered fire (must be owned by the current actor).',
  parameters: v.object({
    eventId: v.string(),
    slug: SlugSchema,
  }),
  execute: async ({ eventId, slug }) => {
    const manager = requireManager();
    const ownerScope = deriveOwnerScope(String(eventId));
    const owned = loadOwnedSchedule(manager.store, String(slug), ownerScope);
    if (!owned.ok) {
      return JSON.stringify({ error: owned.error });
    }
    const result = manager.fireNow(String(slug));
    if (!result) {
      return JSON.stringify({ error: `schedule '${slug}' not found` });
    }
    return JSON.stringify({ slug, runId: result.runId, instanceId: scheduleInstanceId(owned.record.id, result.runId) });
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
    const manager = requireManager();
    const ownerScope = deriveOwnerScope(String(eventId));
    const owned = loadOwnedSchedule(manager.store, String(slug), ownerScope);
    if (!owned.ok) {
      return JSON.stringify({ error: owned.error });
    }
    const runs = manager.store.listRuns(owned.record.id, typeof limit === 'number' ? limit : 50);
    return JSON.stringify({ slug, runs });
  },
});