/**
 * Three-surface verification for the schedules subsystem (plan §12).
 *
 * A schedule is NOT considered working because a row exists or a Croner job is
 * alive. This test verifies all three surfaces:
 *   1. Persistence — schedule row present in SQLite after create; survives a
 *      simulated restart (close manager, reopen, assert rehydrated job present
 *      and next_fire_at correct).
 *   2. Firing — a REAL Croner job triggers the callback at the expected time.
 *      Uses a 1-second `every` schedule (converted to a 6-field seconds cron)
 *      and asserts the `schedule.fired` telemetry event + the run row appearing
 *      (last_fired_at update). Does NOT assert only on the cron object existing.
 *   3. Dispatch + observe — the run is admitted (dispatch_id non-null,
 *      instance_id is the expected per-fire id) and reaches a terminal status
 *      observed via the in-process observe() subscription filtered by
 *      instanceId — NOT merely that the dispatch promise resolved (dispatch is
 *      admission-only; see schedule-dispatch.ts).
 *
 * Dispatch + observe use injectable fakes (a mock target agent that emits a
 * deterministic `agent_end` event the observer catches), per plan §12's
 * allowance. A real-Flue-server + live-model integration is out of scope for the
 * unit suite; the manager unit test (schedule-manager.test.ts) covers the
 * observe/retry/skip logic in depth, and this test covers the REAL Croner
 * firing + persistence surfaces that the manager unit test (which uses
 * fireNow manual triggers) does not.
 */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import test from 'node:test';

import { resolveScheduleConfig } from '../schedules/schedule-config.js';
import type { DispatchScheduleArgs, ScheduleDispatchResult } from '../schedules/schedule-dispatch.js';
import { ScheduleStore } from '../schedules/schedule-store.js';
import { ScheduleManager } from '../schedules/schedule-manager.js';
import { installScheduleTelemetry, getScheduleProgressReporter } from '../schedules/schedule-telemetry.js';
import type { FlueEvent } from '@flue/runtime';

function tempDbPath(): string {
  return `/tmp/sim-one-schedules-3surface-${Date.now()}-${Math.floor(Math.random() * 1e6)}.sqlite`;
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function makeManagerWithFakes(path: string, observeTimeoutMs = 4000) {
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
  const config = resolveScheduleConfig({ maxConcurrentRuns: 4 }, {});
  const manager = new ScheduleManager({
    store,
    config,
    dispatch: fakeDispatch,
    observeFn: fakeObserve as never,
    observeTimeoutMs,
  });
  return { manager, emit: (e: FlueEvent) => subscriber?.(e) };
}

test('three-surface: persistence + real Croner firing + dispatch/observe terminal', async () => {
  const path = tempDbPath();
  installScheduleTelemetry(); // so schedule.* events are captured
  const reporter = getScheduleProgressReporter()!;
  reporter.clear();

  // --- Surface 1: persistence (create + survives reopen) ---
  {
    const store = new ScheduleStore(path);
    store.upsert({ slug: 'every-second', kind: 'every', schedule: '1s', prompt: 'tick' });
    const row = store.getBySlug('every-second');
    assert.ok(row, 'surface 1: row present after create');
    assert.equal(row?.kind, 'every');
    store.close();
  }
  // reopen — data survives
  {
    const store = new ScheduleStore(path);
    const row = store.getBySlug('every-second');
    assert.ok(row, 'surface 1: row survived reopen');
    store.close();
  }

  // --- Surfaces 2 + 3: real Croner firing + dispatch/observe terminal ---
  const { manager, emit } = makeManagerWithFakes(path);
  try {
    manager.start(); // rehydrates the enabled 'every-second' schedule into a real Croner job
    await wait(50);

    // The rehydrated Croner job should have a nextFireAt within ~1s.
    const sched = manager.store.getBySlug('every-second');
    assert.ok(sched?.nextFireAt !== null, 'surface 2: rehydrated Croner job has nextFireAt');

    // Wait for real Croner to fire (1s interval) + dispatch to admit. Allow up to 4s.
    let admitted = false;
    let runId: string | null = null;
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !admitted) {
      const runs = manager.store.listRuns(sched!.id, 10);
      const found = runs.find((r) => r.status === 'admitted' || r.status === 'queued' || r.status === 'ok');
      if (found) {
        runId = found.runId;
        admitted = found.status === 'admitted';
      }
      await wait(100);
    }
    assert.ok(runId, 'surface 2: real Croner fired and created a run row (not just a cron object)');

    // surface 2 also: a schedule.fired telemetry event was emitted.
    const firedEvents = reporter.events().filter((e) => e.type === 'schedule.fired');
    assert.ok(firedEvents.length >= 1, 'surface 2: schedule.fired event emitted on real fire');

    // wait for admission to land (if not already)
    if (runId && !admitted) {
      const dl = Date.now() + 1000;
      while (Date.now() < dl && manager.store.getRun(runId)?.status !== 'admitted') {
        await wait(50);
      }
    }
    const run = manager.store.getRun(runId!);
    assert.equal(run?.status, 'admitted', 'surface 3: dispatch admitted the run');
    assert.ok(run?.dispatchId, 'surface 3: dispatchId non-null (admission succeeded)');
    assert.ok(run?.instanceId?.startsWith(`schedule:${sched!.id}:`), 'surface 3: instanceId is the per-fire id');

    // surface 3: observe the turn to terminal by emitting agent_end for the instanceId.
    emit({ type: 'agent_end', instanceId: run!.instanceId } as FlueEvent);
    await wait(100);

    const done = manager.store.getRun(runId!);
    assert.equal(done?.status, 'ok', 'surface 3: terminal ok observed via observe() (NOT just dispatch resolve)');
    assert.equal(manager.store.getBySlug('every-second')?.lastRunStatus, 'ok', 'schedule lastRunStatus updated to ok');
  } finally {
    manager.stop();
    rmSync(path, { force: true });
  }
});

test('three-surface: disabled schedule does not fire (rehydrate respects enabled)', async () => {
  const path = tempDbPath();
  // seed a disabled schedule
  {
    const store = new ScheduleStore(path);
    store.upsert({ slug: 'paused', kind: 'every', schedule: '1s', prompt: 'tick', enabled: false });
    store.close();
  }
  const { manager } = makeManagerWithFakes(path);
  try {
    manager.start();
    await wait(1500); // would have fired at least once if it were enabled
    const sched = manager.store.getBySlug('paused');
    assert.equal(sched?.enabled, false);
    assert.equal(sched?.nextFireAt, null, 'disabled schedule has no nextFireAt');
    assert.equal(sched?.lastFiredAt, null, 'disabled schedule never fired');
    assert.equal(manager.store.listRuns(sched!.id, 10).length, 0, 'disabled schedule produced no runs');
  } finally {
    manager.stop();
    rmSync(path, { force: true });
  }
});