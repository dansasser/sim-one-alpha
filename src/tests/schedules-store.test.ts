/**
 * Focused CRUD + run-history unit test for ScheduleStore (node:sqlite).
 * Complementary to schedules.test.ts (which does the three-surface firing
 * verification). Exercises the store at runtime to prove it actually does
 * CRUD — not just that it compiles ("running is not working").
 */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import test from 'node:test';

import { ScheduleStore, ScheduleValidationError } from '../schedules/schedule-store.js';
import type { ScheduleDefinition } from '../schedules/schedule-types.js';

function tempDbPath(): string {
  return `/tmp/sim-one-schedules-store-${Date.now()}-${Math.floor(Math.random() * 1e6)}.sqlite`;
}

const validDef: ScheduleDefinition = {
  slug: 'daily-summary',
  kind: 'cron',
  schedule: '0 9 * * *',
  prompt: 'Review recent activity and prepare the daily summary.',
};

test('ScheduleStore upsert creates a row with generated id and defaults', () => {
  const path = tempDbPath();
  const store = new ScheduleStore(path);
  try {
    const created = store.upsert(validDef);
    assert.ok(created.id, 'id generated');
    assert.equal(created.slug, 'daily-summary');
    assert.equal(created.kind, 'cron');
    assert.equal(created.timezone, 'UTC');
    assert.equal(created.targetAgent, 'orchestrator');
    assert.equal(created.enabled, true);
    assert.equal(created.protect, true);
    assert.equal(created.maxAttempts, 3);
    assert.equal(created.deleteAfterRun, false, 'cron kind defaults deleteAfterRun to false');
    assert.ok(created.createdAt > 0);
    assert.equal(created.createdAt, created.updatedAt);
  } finally {
    store.close();
    rmSync(path, { force: true });
  }
});

test('ScheduleStore upsert on a taken slug merges in place (keeps id)', () => {
  const path = tempDbPath();
  const store = new ScheduleStore(path);
  try {
    const first = store.upsert(validDef);
    const merged = store.upsert({ ...validDef, schedule: '0 10 * * *', prompt: 'Updated.' });
    assert.equal(merged.id, first.id, 'merge keeps the same id');
    assert.equal(merged.schedule, '0 10 * * *');
    assert.equal(merged.prompt, 'Updated.');
  } finally {
    store.close();
    rmSync(path, { force: true });
  }
});

test('ScheduleStore upsert with mergeExisting=false on a taken slug throws', () => {
  const path = tempDbPath();
  const store = new ScheduleStore(path);
  try {
    store.upsert(validDef);
    assert.throws(
      () => store.upsert(validDef, { mergeExisting: false }),
      ScheduleValidationError,
    );
  } finally {
    store.close();
    rmSync(path, { force: true });
  }
});

test('ScheduleStore validates kind / slug / prompt / schedule', () => {
  const path = tempDbPath();
  const store = new ScheduleStore(path);
  try {
    assert.throws(
      () => store.upsert({ ...validDef, kind: 'bogus' as never }),
      ScheduleValidationError,
    );
    assert.throws(() => store.upsert({ ...validDef, slug: '' }), ScheduleValidationError);
    assert.throws(() => store.upsert({ ...validDef, schedule: '' }), ScheduleValidationError);
    assert.throws(() => store.upsert({ ...validDef, prompt: '' }), ScheduleValidationError);
  } finally {
    store.close();
    rmSync(path, { force: true });
  }
});

test('ScheduleStore one-shot (kind=at) defaults deleteAfterRun to true', () => {
  const path = tempDbPath();
  const store = new ScheduleStore(path);
  try {
    const oneShot = store.upsert({
      slug: 'oneshot-remind',
      kind: 'at',
      schedule: '2026-06-23T10:00:00Z',
      prompt: 'Remind me.',
    });
    assert.equal(oneShot.deleteAfterRun, true, 'at kind defaults deleteAfterRun to true');
  } finally {
    store.close();
    rmSync(path, { force: true });
  }
});

test('ScheduleStore list / getBySlug / getById / setEnabled / updateFields / delete', () => {
  const path = tempDbPath();
  const store = new ScheduleStore(path);
  try {
    store.upsert(validDef);
    store.upsert({ slug: 'hourly', kind: 'every', schedule: '20m', prompt: 'Check.' });

    assert.equal(store.list().length, 2);
    assert.equal(store.getBySlug('daily-summary')?.slug, 'daily-summary');
    const byId = store.getBySlug('daily-summary');
    assert.ok(byId, 'byId present');
    assert.ok(store.getById(byId.id));

    const paused = store.setEnabled('daily-summary', false);
    assert.equal(paused?.enabled, false);
    assert.equal(store.list().filter((r) => r.slug === 'daily-summary')[0].enabled, false);

    const onlyEnabled = store.listEnabled();
    assert.equal(onlyEnabled.length, 1, 'only the hourly schedule remains enabled');
    assert.equal(onlyEnabled[0].slug, 'hourly');

    const updated = store.updateFields('hourly', { prompt: 'New check.', enabled: false });
    assert.equal(updated?.prompt, 'New check.');
    assert.equal(updated?.enabled, false);

    assert.equal(store.delete('daily-summary'), true);
    assert.equal(store.delete('daily-summary'), false, 'second delete is a no-op');
    assert.equal(store.list().length, 1);
  } finally {
    store.close();
    rmSync(path, { force: true });
  }
});

test('ScheduleStore run history: start -> admit -> terminal updates schedule + run rows', () => {
  const path = tempDbPath();
  const store = new ScheduleStore(path);
  try {
    const sched = store.upsert(validDef);
    const run = store.recordRunStart(sched.id, 'run-001');
    assert.equal(run.status, 'queued');
    assert.equal(run.instanceId, `schedule:${sched.id}:run-001`);
    assert.equal(run.dispatchId, null);
    assert.equal(run.attempt, 0);

    store.recordRunAdmitted('run-001', 'dispatch-abc', new Date().toISOString());
    const admitted = store.getRun('run-001');
    assert.equal(admitted?.status, 'admitted');
    assert.equal(admitted?.dispatchId, 'dispatch-abc');
    assert.ok(admitted?.admittedAt !== null, 'admittedAt set');

    const nextFire = Date.now() + 3_600_000;
    store.recordRunTerminal('run-001', 'ok', { firedAtMs: Date.now(), nextFireAt: nextFire });
    const done = store.getRun('run-001');
    assert.equal(done?.status, 'ok');
    assert.ok(done?.finishedAt !== null, 'finishedAt set');

    const schedAfter = store.getBySlug('daily-summary');
    assert.equal(schedAfter?.lastRunStatus, 'ok', 'schedule lastRunStatus updated');
    assert.ok(schedAfter?.lastFiredAt !== null, 'lastFiredAt set');
    assert.equal(schedAfter?.nextFireAt, nextFire, 'nextFireAt set');
  } finally {
    store.close();
    rmSync(path, { force: true });
  }
});

test('ScheduleStore recordRunTerminal rejects non-terminal status', () => {
  const path = tempDbPath();
  const store = new ScheduleStore(path);
  try {
    const sched = store.upsert(validDef);
    store.recordRunStart(sched.id, 'run-x');
    assert.throws(
      () => store.recordRunTerminal('run-x', 'admitted' as never),
      ScheduleValidationError,
    );
  } finally {
    store.close();
    rmSync(path, { force: true });
  }
});

test('ScheduleStore recordRunRetry advances attempt and resets admission fields', () => {
  const path = tempDbPath();
  const store = new ScheduleStore(path);
  try {
    const sched = store.upsert(validDef);
    store.recordRunStart(sched.id, 'run-retry');
    store.recordRunAdmitted('run-retry', 'dispatch-1', new Date().toISOString());
    store.recordRunRetry('run-retry', `schedule:${sched.id}:run-retry`);
    const after = store.getRun('run-retry');
    assert.equal(after?.attempt, 1, 'attempt incremented');
    assert.equal(after?.status, 'queued', 'status reset to queued');
    assert.equal(after?.dispatchId, null, 'dispatchId cleared');
    assert.equal(after?.admittedAt, null, 'admittedAt cleared');
    assert.equal(after?.instanceId, `schedule:${sched.id}:run-retry`);
  } finally {
    store.close();
    rmSync(path, { force: true });
  }
});

test('ScheduleStore listRuns / listInFlightRuns / cleanup', () => {
  const path = tempDbPath();
  const store = new ScheduleStore(path);
  try {
    const sched = store.upsert(validDef);
    for (let i = 0; i < 5; i += 1) {
      store.recordRunStart(sched.id, `run-${i}`);
    }
    // mark two as in-flight (admitted but not terminal)
    store.recordRunAdmitted('run-3', 'd3', new Date().toISOString());
    store.recordRunAdmitted('run-4', 'd4', new Date().toISOString());
    store.recordRunTerminal('run-0', 'ok');
    store.recordRunTerminal('run-1', 'error', { error: 'boom' });

    const allRuns = store.listRuns(sched.id, 100);
    assert.equal(allRuns.length, 5);

    // run-2 was never admitted/terminalized, so it is still 'queued' and counts
    // as in-flight alongside the two admitted runs (run-3, run-4).
    const inFlight = store.listInFlightRuns();
    assert.equal(inFlight.length, 3, 'queued + admitted-but-not-terminal runs are in flight');
    assert.ok(
      inFlight.every((r) => r.status === 'queued' || r.status === 'admitted'),
      'every in-flight run is non-terminal',
    );

    // keep only the 2 most recent runs per schedule -> prune 3
    const pruned = store.cleanup(2);
    assert.ok(pruned >= 3, `cleanup pruned at least 3 rows (got ${pruned})`);
    const remaining = store.listRuns(sched.id, 100);
    assert.ok(remaining.length <= 2, `at most 2 runs remain after cleanup (got ${remaining.length})`);
  } finally {
    store.close();
    rmSync(path, { force: true });
  }
});

test('ScheduleStore survives a reopen (persistence across manager restart)', () => {
  const path = tempDbPath();
  const schedId = (() => {
    const store = new ScheduleStore(path);
    const sched = store.upsert(validDef);
    store.recordRunStart(sched.id, 'run-persist');
    store.recordRunTerminal('run-persist', 'ok');
    store.close();
    return sched.id;
  })();

  // Reopen — schema is idempotent, data survives.
  const store2 = new ScheduleStore(path);
  try {
    const sched = store2.getById(schedId);
    assert.ok(sched, 'schedule survived reopen');
    assert.equal(sched?.slug, 'daily-summary');
    assert.equal(sched?.lastRunStatus, 'ok', 'run history survived reopen');
    const runs = store2.listRuns(schedId, 100);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'ok');
  } finally {
    store2.close();
    rmSync(path, { force: true });
  }
});
test('ScheduleStore delete cascades run history (FK enforced)', () => {
  const path = tempDbPath();
  const store = new ScheduleStore(path);
  try {
    const sched = store.upsert(validDef);
    store.recordRunStart(sched.id, 'run-cascade-1');
    store.recordRunStart(sched.id, 'run-cascade-2');
    assert.equal(store.listRuns(sched.id, 100).length, 2, 'two runs exist before delete');
    assert.equal(store.delete('daily-summary'), true);
    assert.equal(store.getBySlug('daily-summary'), null, 'schedule gone');
    assert.equal(store.listRuns(sched.id, 100).length, 0, 'run rows cascade-removed with the schedule');
  } finally {
    store.close();
    rmSync(path, { force: true });
  }
});
