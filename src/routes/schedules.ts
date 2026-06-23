/**
 * Admin HTTP route for schedules (plan §10, full v1).
 *
 * Registered in `src/app.ts` behind `requireApiSecret` (applied at
 * `app.use('/api/schedules/*', requireApiSecret)`). Handlers do NOT run
 * orchestration inline: create/update/delete/pause/resume mutate the SQLite row
 * and call `ScheduleManager.syncCron()`; `run` calls `ScheduleManager.fireNow()`
 * which goes through the same `dispatch(...)` path as a Croner-triggered fire.
 * This keeps the admin route as app-owned ingress that forwards into the Flue
 * agent path (per `docs/architecture/flue-architecture.md`).
 *
 * `?wait=1` on the run endpoint polls the returned runId until it reaches a
 * terminal status (ok/error/skipped/timeout/lost) or a 60s cap, mirroring
 * OpenClaw's `--wait` (0 for ok, non-zero for error/skipped/timeout).
 */

import type { Hono } from 'hono';

import { getScheduleManager } from '../schedules/boot.js';
import type { ScheduleManager } from '../schedules/schedule-manager.js';
import type { ScheduleDefinition, ScheduleKind, ScheduleRunStatus, ScheduleTargetAgent } from '../schedules/schedule-types.js';

const ADMIN_OWNER_SCOPE = 'admin';
const WAIT_POLL_INTERVAL_MS = 100;
const WAIT_CAP_MS = 60_000;
const TERMINAL_STATUSES: readonly ScheduleRunStatus[] = ['ok', 'error', 'skipped', 'timeout', 'lost'];

function isString(v: unknown): v is string {
  return typeof v === 'string';
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function managerOr503(): { ok: true; manager: ScheduleManager } | { ok: false; status: number; body: unknown } {
  const manager = getScheduleManager();
  if (!manager) {
    return { ok: false, status: 503, body: { error: 'Schedules are not enabled on this server.' } };
  }
  return { ok: true, manager };
}

function parseDefinition(body: unknown): { ok: true; def: ScheduleDefinition } | { ok: false; status: number; body: unknown } {
  if (!isRecord(body)) {
    return { ok: false, status: 400, body: { error: 'Invalid JSON payload.' } };
  }
  const slug = isString(body.slug) && body.slug.trim() ? body.slug : null;
  const kind = body.kind;
  const schedule = isString(body.schedule) && body.schedule.trim() ? body.schedule : null;
  const prompt = isString(body.prompt) && body.prompt.trim() ? body.prompt : null;
  if (!slug) {
    return { ok: false, status: 400, body: { error: 'slug is required.' } };
  }
  if (kind !== 'cron' && kind !== 'every' && kind !== 'at') {
    return { ok: false, status: 400, body: { error: "kind must be 'cron', 'every', or 'at'." } };
  }
  if (!schedule) {
    return { ok: false, status: 400, body: { error: 'schedule is required.' } };
  }
  if (!prompt) {
    return { ok: false, status: 400, body: { error: 'prompt is required.' } };
  }
  const def: ScheduleDefinition = {
    slug,
    kind: kind as ScheduleKind,
    schedule,
    prompt,
    ownerScope: ADMIN_OWNER_SCOPE,
  };
  if (isString(body.targetAgent) && (body.targetAgent === 'orchestrator' || body.targetAgent === 'coding-worker')) {
    def.targetAgent = body.targetAgent as ScheduleTargetAgent;
  }
  if (isString(body.tz) && body.tz.trim()) {
    def.timezone = body.tz;
  }
  if (isRecord(body.payload)) {
    def.payload = body.payload;
  }
  if (typeof body.enabled === 'boolean') {
    def.enabled = body.enabled;
  }
  if (typeof body.deleteAfterRun === 'boolean') {
    def.deleteAfterRun = body.deleteAfterRun;
  }
  if (typeof body.maxAttempts === 'number') {
    def.maxAttempts = body.maxAttempts;
  }
  return { ok: true, def };
}

function readJsonBody(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  return c.req.json();
}

export function registerSchedulesRoutes(app: Hono): void {
  app.get('/api/schedules', (c) => {
    const m = managerOr503();
    if (!m.ok) {
      return c.json(m.body, m.status as 503);
    }
    return c.json({ schedules: m.manager.store.list() });
  });

  app.get('/api/schedules/:slug', (c) => {
    const m = managerOr503();
    if (!m.ok) {
      return c.json(m.body, m.status as 503);
    }
    const slug = c.req.param('slug');
    const record = m.manager.store.getBySlug(slug);
    if (!record) {
      return c.json({ error: `schedule '${slug}' not found` }, 404);
    }
    return c.json({ schedule: record });
  });

  app.post('/api/schedules', async (c) => {
    const m = managerOr503();
    if (!m.ok) {
      return c.json(m.body, m.status as 503);
    }
    let body: unknown;
    try {
      body = await readJsonBody(c);
    } catch {
      return c.json({ error: 'Invalid JSON payload.' }, 400);
    }
    const parsed = parseDefinition(body);
    if (!parsed.ok) {
      return c.json(parsed.body, parsed.status as 400);
    }
    try {
      const record = m.manager.store.upsert(parsed.def);
      m.manager.syncCron(record);
      return c.json({ schedule: record }, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.patch('/api/schedules/:slug', async (c) => {
    const m = managerOr503();
    if (!m.ok) {
      return c.json(m.body, m.status as 503);
    }
    const slug = c.req.param('slug');
    let body: unknown;
    try {
      body = await readJsonBody(c);
    } catch {
      return c.json({ error: 'Invalid JSON payload.' }, 400);
    }
    if (!isRecord(body)) {
      return c.json({ error: 'Invalid JSON payload.' }, 400);
    }
    const existing = m.manager.store.getBySlug(slug);
    if (!existing) {
      return c.json({ error: `schedule '${slug}' not found` }, 404);
    }
    const record = m.manager.store.updateFields(slug, {
      ...(isString(body.schedule) && body.schedule.trim() ? { schedule: body.schedule } : {}),
      ...(isString(body.prompt) && body.prompt.trim() ? { prompt: body.prompt } : {}),
      ...(body.payload === null || isRecord(body.payload) ? { payload: isRecord(body.payload) ? body.payload : null } : {}),
      ...(isString(body.tz) && body.tz.trim() ? { timezone: body.tz } : {}),
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
    });
    if (record) {
      m.manager.syncCron(record);
    }
    return c.json({ schedule: record });
  });

  app.post('/api/schedules/:slug/pause', (c) => {
    const m = managerOr503();
    if (!m.ok) {
      return c.json(m.body, m.status as 503);
    }
    const slug = c.req.param('slug');
    const record = m.manager.store.setEnabled(slug, false);
    if (!record) {
      return c.json({ error: `schedule '${slug}' not found` }, 404);
    }
    m.manager.syncCron(record);
    return c.json({ slug, paused: true });
  });

  app.post('/api/schedules/:slug/resume', (c) => {
    const m = managerOr503();
    if (!m.ok) {
      return c.json(m.body, m.status as 503);
    }
    const slug = c.req.param('slug');
    const record = m.manager.store.setEnabled(slug, true);
    if (!record) {
      return c.json({ error: `schedule '${slug}' not found` }, 404);
    }
    m.manager.syncCron(record);
    return c.json({ slug, resumed: true, nextFireAt: record.nextFireAt });
  });

  app.delete('/api/schedules/:slug', (c) => {
    const m = managerOr503();
    if (!m.ok) {
      return c.json(m.body, m.status as 503);
    }
    const slug = c.req.param('slug');
    const deleted = m.manager.store.delete(slug);
    if (!deleted) {
      return c.json({ error: `schedule '${slug}' not found` }, 404);
    }
    return c.json({ slug, deleted: true });
  });

  app.post('/api/schedules/:slug/run', async (c) => {
    const m = managerOr503();
    if (!m.ok) {
      return c.json(m.body, m.status as 503);
    }
    const slug = c.req.param('slug');
    const wait = c.req.query('wait') === '1';
    const result = m.manager.fireNow(slug);
    if (!result) {
      return c.json({ error: `schedule '${slug}' not found` }, 404);
    }
    if (!wait) {
      return c.json({ slug, runId: result.runId });
    }
    // ?wait=1: poll until terminal or 60s cap.
    const deadline = Date.now() + WAIT_CAP_MS;
    let run = m.manager.store.getRun(result.runId);
    while (Date.now() < deadline) {
      run = m.manager.store.getRun(result.runId);
      if (run && (TERMINAL_STATUSES as readonly string[]).includes(run.status)) {
        break;
      }
      await new Promise((r) => setTimeout(r, WAIT_POLL_INTERVAL_MS));
    }
    if (!run) {
      return c.json({ slug, runId: result.runId, status: 'lost' }, 504);
    }
    const ok = run.status === 'ok';
    return c.json({ slug, runId: result.runId, status: run.status, error: run.error }, ok ? 200 : 502);
  });

  app.get('/api/schedules/:slug/runs', (c) => {
    const m = managerOr503();
    if (!m.ok) {
      return c.json(m.body, m.status as 503);
    }
    const slug = c.req.param('slug');
    const record = m.manager.store.getBySlug(slug);
    if (!record) {
      return c.json({ error: `schedule '${slug}' not found` }, 404);
    }
    const limitParam = c.req.query('limit');
    const limit = limitParam && /^\d+$/.test(limitParam) ? Math.min(Number(limitParam), 500) : 50;
    return c.json({ slug, runs: m.manager.store.listRuns(record.id, limit) });
  });

  app.get('/api/schedules/:slug/runs/:runId', (c) => {
    const m = managerOr503();
    if (!m.ok) {
      return c.json(m.body, m.status as 503);
    }
    const slug = c.req.param('slug');
    const runId = c.req.param('runId');
    const record = m.manager.store.getBySlug(slug);
    if (!record) {
      return c.json({ error: `schedule '${slug}' not found` }, 404);
    }
    const run = m.manager.store.getRun(runId);
    if (!run || run.scheduleId !== record.id) {
      return c.json({ error: `run '${runId}' not found for schedule '${slug}'` }, 404);
    }
    return c.json({ slug, run });
  });
}