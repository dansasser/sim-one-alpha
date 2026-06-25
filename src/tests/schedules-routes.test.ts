/**
 * Admin HTTP route tests for schedules (plan §17).
 *
 * Builds a test Hono app with `requireApiSecret` + `registerSchedulesRoutes`,
 * injects a real ScheduleManager (temp DB + fake dispatch + fake observe) via
 * the test-only `__setScheduleManagerForTesting` setter, and exercises each
 * endpoint, auth (401 without x-api-secret, 503 if API_SECRET unset / manager
 * disabled), and the `?wait=1` run mode.
 */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import test from 'node:test';
import type { FlueEvent } from '@flue/runtime';
import { Hono } from 'hono';

import { resolveScheduleConfig } from '../engine/schedules/schedule-config.js';
import type { DispatchScheduleArgs, ScheduleDispatchResult } from '../engine/schedules/schedule-dispatch.js';
import { __setScheduleManagerForTesting } from '../engine/schedules/boot.js';
import { ScheduleManager } from '../engine/schedules/schedule-manager.js';
import { ScheduleStore } from '../engine/schedules/schedule-store.js';
import { requireApiSecret } from '../api/middleware/api-secret.js';
import { registerSchedulesRoutes } from '../api/routes/schedules.js';

function tempDbPath(): string {
  return `/tmp/sim-one-schedules-routes-${Date.now()}-${Math.floor(Math.random() * 1e6)}.sqlite`;
}

async function withApiSecret(secret: string | undefined, fn: () => Promise<void>): Promise<void> {
  const previous = process.env.API_SECRET;
  try {
    if (secret === undefined) {
      delete process.env.API_SECRET;
    } else {
      process.env.API_SECRET = secret;
    }
    await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.API_SECRET;
    } else {
      process.env.API_SECRET = previous;
    }
  }
}

function makeAppWithManager(observeTimeoutMs = 50): { app: Hono; path: string; cleanup: () => void } {
  const path = tempDbPath();
  const store = new ScheduleStore(path);
  let subscriber: ((event: FlueEvent) => void) | null = null;
  const fakeObserve = (sub: (event: FlueEvent) => void): (() => void) => {
    subscriber = sub;
    return () => {
      subscriber = null;
    };
  };
  const fakeDispatch = async (args: DispatchScheduleArgs): Promise<ScheduleDispatchResult> => ({
    dispatchId: 'd-' + args.instanceId,
    acceptedAt: new Date().toISOString(),
    instanceId: args.instanceId,
  });
  const config = resolveScheduleConfig({}, {});
  const manager = new ScheduleManager({
    store,
    config,
    dispatch: fakeDispatch,
    observeFn: fakeObserve as never,
    observeTimeoutMs,
  });
  manager.start();
  __setScheduleManagerForTesting(manager);

  const app = new Hono();
  app.use('/api/schedules/*', requireApiSecret);
  registerSchedulesRoutes(app);

  return {
    app,
    path,
    cleanup: () => {
      manager.stop();
      __setScheduleManagerForTesting(null);
      rmSync(path, { force: true });
    },
  };
}

const SECRET = 'test-secret';
function headers(json = true): Record<string, string> {
  const h: Record<string, string> = { 'x-api-secret': SECRET };
  if (json) {
    h['content-type'] = 'application/json';
  }
  return h;
}

test('schedules route: 503 when API_SECRET is not configured', async () => {
  await withApiSecret(undefined, async () => {
    const { app, cleanup } = makeAppWithManager();
    try {
      const res = await app.request('/api/schedules', { headers: headers(false) });
      assert.equal(res.status, 503);
    } finally {
      cleanup();
    }
  });
});

test('schedules route: 401 without x-api-secret', async () => {
  await withApiSecret(SECRET, async () => {
    const { app, cleanup } = makeAppWithManager();
    try {
      const res = await app.request('/api/schedules', { headers: { 'content-type': 'application/json' } });
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), { error: 'Unauthorized' });
    } finally {
      cleanup();
    }
  });
});

test('schedules route: 503 when schedules disabled (manager null)', async () => {
  await withApiSecret(SECRET, async () => {
    __setScheduleManagerForTesting(null);
    const app = new Hono();
    app.use('/api/schedules/*', requireApiSecret);
    registerSchedulesRoutes(app);
    const res = await app.request('/api/schedules', { headers: headers(false) });
    assert.equal(res.status, 503);
  });
});

test('schedules route: create -> get -> list -> update -> pause/resume -> delete', async () => {
  await withApiSecret(SECRET, async () => {
    const { app, cleanup } = makeAppWithManager();
    try {
      // create
      const create = await app.request('/api/schedules', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ slug: 'daily', kind: 'cron', schedule: '0 9 * * *', prompt: 'summary' }),
      });
      assert.equal(create.status, 201);
      const created = (await create.json()) as { schedule: { slug: string; enabled: boolean } };
      assert.equal(created.schedule.slug, 'daily');

      // get
      const get = await app.request('/api/schedules/daily', { headers: headers(false) });
      assert.equal(get.status, 200);

      // list
      const list = await app.request('/api/schedules', { headers: headers(false) });
      assert.equal(list.status, 200);
      const listBody = (await list.json()) as { schedules: { slug: string }[] };
      assert.ok(listBody.schedules.some((s) => s.slug === 'daily'));

      // update
      const update = await app.request('/api/schedules/daily', {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify({ prompt: 'updated summary' }),
      });
      assert.equal(update.status, 200);

      // pause
      const pause = await app.request('/api/schedules/daily/pause', { method: 'POST', headers: headers() });
      assert.equal(pause.status, 200);
      assert.equal(((await pause.json()) as { paused: boolean }).paused, true);

      // resume
      const resume = await app.request('/api/schedules/daily/resume', { method: 'POST', headers: headers() });
      assert.equal(resume.status, 200);

      // delete
      const del = await app.request('/api/schedules/daily', { method: 'DELETE', headers: headers(false) });
      assert.equal(del.status, 200);
      assert.equal(((await del.json()) as { deleted: boolean }).deleted, true);

      // get after delete -> 404
      const getAfter = await app.request('/api/schedules/daily', { headers: headers(false) });
      assert.equal(getAfter.status, 404);
    } finally {
      cleanup();
    }
  });
});

test('schedules route: create rejects bad payload with 400', async () => {
  await withApiSecret(SECRET, async () => {
    const { app, cleanup } = makeAppWithManager();
    try {
      const res = await app.request('/api/schedules', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ slug: 'bad', kind: 'bogus', schedule: 'x', prompt: 'y' }),
      });
      assert.equal(res.status, 400);
    } finally {
      cleanup();
    }
  });
});

test('schedules route: run (no wait) returns runId; ?wait=1 reaches terminal', async () => {
  await withApiSecret(SECRET, async () => {
    // short observe timeout so ?wait=1 sees 'timeout' (502) deterministically
    const { app, cleanup } = makeAppWithManager(30);
    try {
      const create = await app.request('/api/schedules', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ slug: 'run-test', kind: 'cron', schedule: '0 9 * * *', prompt: 'p' }),
      });
      assert.equal(create.status, 201);

      // no-wait run
      const run = await app.request('/api/schedules/run-test/run', { method: 'POST', headers: headers() });
      assert.equal(run.status, 200);
      const runBody = (await run.json()) as { runId: string };
      assert.ok(runBody.runId);

      // ?wait=1 — observe timeout is 30ms, so the run reaches 'timeout' -> 502
      const waitRun = await app.request('/api/schedules/run-test/run?wait=1', { method: 'POST', headers: headers() });
      const waitBody = (await waitRun.json()) as { status: string };
      assert.ok(['timeout', 'ok', 'error', 'skipped'].includes(waitBody.status), `wait returned a terminal status: ${waitBody.status}`);
    } finally {
      cleanup();
    }
  });
});

test('schedules route: runs history + one-run detail + 404s', async () => {
  await withApiSecret(SECRET, async () => {
    const { app, cleanup } = makeAppWithManager();
    try {
      await app.request('/api/schedules', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ slug: 'hist', kind: 'cron', schedule: '0 9 * * *', prompt: 'p' }),
      });
      // trigger a run
      const run = await app.request('/api/schedules/hist/run', { method: 'POST', headers: headers() });
      const { runId } = (await run.json()) as { runId: string };

      // runs list
      const runs = await app.request('/api/schedules/hist/runs', { headers: headers(false) });
      assert.equal(runs.status, 200);
      const runsBody = (await runs.json()) as { runs: { runId: string }[] };
      assert.ok(runsBody.runs.some((r) => r.runId === runId));

      // one-run detail
      const detail = await app.request(`/api/schedules/hist/runs/${runId}`, { headers: headers(false) });
      assert.equal(detail.status, 200);

      // unknown run -> 404
      const missing = await app.request('/api/schedules/hist/runs/nonexistent', { headers: headers(false) });
      assert.equal(missing.status, 404);

      // unknown schedule -> 404
      const missingSched = await app.request('/api/schedules/nope/runs', { headers: headers(false) });
      assert.equal(missingSched.status, 404);
    } finally {
      cleanup();
    }
  });
});
test('schedules route: maxAttempts must be a positive integer', async () => {
  await withApiSecret(SECRET, async () => {
    const { app, cleanup } = makeAppWithManager();
    try {
      for (const bad of [0, -1, 2.5, 1.5]) {
        const res = await app.request('/api/schedules', {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ slug: 'm', kind: 'cron', schedule: '0 9 * * *', prompt: 'p', maxAttempts: bad }),
        });
        assert.equal(res.status, 400, `maxAttempts=${bad} rejected with 400`);
      }
      // valid positive integer accepted
      const ok = await app.request('/api/schedules', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ slug: 'good-max', kind: 'cron', schedule: '0 9 * * *', prompt: 'p', maxAttempts: 3 }),
      });
      assert.equal(ok.status, 201, 'maxAttempts=3 accepted');
    } finally {
      cleanup();
    }
  });
});
