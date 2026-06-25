/**
 * Focused unit test for ScheduleManager fire flow + pure helpers (plan §7, §12).
 * Uses injected fake dispatch + fake observe so the manager's admit/observe/
 * terminal/retry/skip/auto-delete logic is verified at runtime WITHOUT a real
 * Flue server or live model. The real three-surface firing+dispatch integration
 * (against the actual Flue runtime + a minimal real agent) is in task #12.
 */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import test from 'node:test';
import type { FlueEvent } from '@flue/runtime';

import { resolveScheduleConfig } from '../engine/schedules/schedule-config.js';
import type { DispatchScheduleArgs, ScheduleDispatchResult } from '../engine/schedules/schedule-dispatch.js';
import { ScheduleStore } from '../engine/schedules/schedule-store.js';
import {
  ScheduleManager,
  classifyError,
  intervalToCron,
  toCronerPattern,
} from '../engine/schedules/schedule-manager.js';
import type { ScheduleKind } from '../engine/schedules/schedule-types.js';

function tempDbPath(): string {
  return `/tmp/sim-one-schedules-mgr-${Date.now()}-${Math.floor(Math.random() * 1e6)}.sqlite`;
}

function makeManager({
  dispatch,
  observeTimeoutMs = 5000,
  backoffMs = [10, 20],
  maxAttempts = 2,
}: {
  dispatch: (args: DispatchScheduleArgs) => Promise<ScheduleDispatchResult>;
  observeTimeoutMs?: number;
  backoffMs?: number[];
  maxAttempts?: number;
}): { manager: ScheduleManager; emit: (event: FlueEvent) => void; path: string } {
  const path = tempDbPath();
  const store = new ScheduleStore(path);
  let subscriber: ((event: FlueEvent) => void) | null = null;
  const fakeObserve = (sub: (event: FlueEvent) => void): (() => void) => {
    subscriber = sub;
    return () => {
      subscriber = null;
    };
  };
  const config = resolveScheduleConfig(
    { maxConcurrentRuns: 2, retry: { maxAttempts, backoffMs, retryOn: ['network'] } },
    {},
  );
  const manager = new ScheduleManager({
    store,
    config,
    dispatch,
    observeFn: fakeObserve as never,
    observeTimeoutMs,
  });
  manager.start();
  return { manager, emit: (event) => subscriber?.(event), path };
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

test('intervalToCron converts Ns/Nm/Nh/Nd to cron expressions', () => {
  assert.equal(intervalToCron('20m'), '*/20 * * * *');
  assert.equal(intervalToCron('1h'), '0 */1 * * *');
  assert.equal(intervalToCron('2h'), '0 */2 * * *');
  assert.equal(intervalToCron('30s'), '*/30 * * * * *');
  assert.equal(intervalToCron('3d'), '0 0 */3 * *');
  assert.equal(intervalToCron('garbage'), null);
  assert.equal(intervalToCron('0m'), null, 'zero rejected');
  assert.equal(intervalToCron('60m'), null, 'minutes capped at 59');
  assert.equal(intervalToCron('24h'), null, 'hours capped at 23');
});

test('toCronerPattern maps kind -> Croner pattern', () => {
  assert.equal(toCronerPattern('cron', '0 9 * * *'), '0 9 * * *');
  assert.equal(toCronerPattern('every', '20m'), '*/20 * * * *');
  assert.equal(toCronerPattern('at', '2026-06-23T10:00:00Z'), '2026-06-23T10:00:00Z');
  assert.equal(toCronerPattern('every', 'bogus'), null);
});

test('classifyError distinguishes transient from permanent', () => {
  assert.equal(classifyError('rate limit exceeded'), 'rate_limit');
  assert.equal(classifyError('server overloaded'), 'overloaded');
  assert.equal(classifyError('fetch failed: ECONNRESET'), 'network');
  assert.equal(classifyError('validation error: bad slug'), 'validation');
  assert.equal(classifyError('provider not configured'), 'provider-unavailable');
  assert.equal(classifyError('500 server error'), 'server_error');
  assert.equal(classifyError(''), 'server_error', 'empty defaults to server_error');
});

test('manager fire: admit -> observe agent_end (ok) -> records ok', async () => {
  const fakeDispatch = async (args: DispatchScheduleArgs): Promise<ScheduleDispatchResult> => ({
    dispatchId: 'd-' + args.instanceId,
    acceptedAt: new Date().toISOString(),
    instanceId: args.instanceId,
  });
  const { manager, emit, path } = makeManager({ dispatch: fakeDispatch });
  try {
    const sched = manager.store.upsert({
      slug: 'ok-test',
      kind: 'every',
      schedule: '10m',
      prompt: 'noop',
    });
    const { runId } = manager.fireNow('ok-test')!;
    // let dispatch + recordRunAdmitted land
    await wait(50);
    const admitted = manager.store.getRun(runId);
    assert.equal(admitted?.status, 'admitted', 'dispatch admitted the run');
    assert.ok(admitted?.dispatchId, 'dispatchId recorded');

    // simulate the agent turn completing successfully
    const instanceId = admitted!.instanceId;
    emit({ type: 'agent_end', instanceId } as FlueEvent);
    await wait(50);

    const done = manager.store.getRun(runId);
    assert.equal(done?.status, 'ok', 'terminal ok recorded');
    assert.equal(manager.store.getBySlug('ok-test')?.lastRunStatus, 'ok', 'schedule lastRunStatus ok');
    void sched;
  } finally {
    manager.stop();
    rmSync(path, { force: true });
  }
});

test('manager fire: turn isError -> agent_end records error', async () => {
  const fakeDispatch = async (args: DispatchScheduleArgs): Promise<ScheduleDispatchResult> => ({
    dispatchId: 'd-' + args.instanceId,
    acceptedAt: new Date().toISOString(),
    instanceId: args.instanceId,
  });
  const { manager, emit, path } = makeManager({ dispatch: fakeDispatch });
  try {
    manager.store.upsert({ slug: 'err-test', kind: 'every', schedule: '10m', prompt: 'noop' });
    const { runId } = manager.fireNow('err-test')!;
    await wait(50);
    const instanceId = manager.store.getRun(runId)!.instanceId;

    // a turn error (permanent: validation) -> should NOT retry (retryOn is ['network'] only)
    emit({ type: 'turn', isError: true, error: 'validation error: bad input', instanceId } as FlueEvent);
    emit({ type: 'agent_end', instanceId } as FlueEvent);
    await wait(50);

    const done = manager.store.getRun(runId);
    assert.equal(done?.status, 'skipped', 'permanent validation error -> skipped (no retry)');
    assert.equal(manager.store.getBySlug('err-test')?.lastRunStatus, 'skipped');
  } finally {
    manager.stop();
    rmSync(path, { force: true });
  }
});

test('manager fire: transient network error retries, then ok', async () => {
  let attempts = 0;
  const fakeDispatch = async (args: DispatchScheduleArgs): Promise<ScheduleDispatchResult> => {
    attempts += 1;
    return { dispatchId: `d-${attempts}`, acceptedAt: new Date().toISOString(), instanceId: args.instanceId };
  };
  const { manager, emit, path } = makeManager({ dispatch: fakeDispatch });
  try {
    manager.store.upsert({ slug: 'retry-test', kind: 'every', schedule: '10m', prompt: 'noop' });
    const { runId } = manager.fireNow('retry-test')!;
    await wait(50);
    let instanceId = manager.store.getRun(runId)!.instanceId;

    // first attempt: transient network error -> should retry
    emit({ type: 'turn', isError: true, error: 'fetch failed: network down', instanceId } as FlueEvent);
    emit({ type: 'agent_end', instanceId } as FlueEvent);
    await wait(80); // backoff is 10ms

    const afterFirst = manager.store.getRun(runId);
    assert.equal(afterFirst?.attempt, 1, 'attempt incremented to 1');
    assert.ok(['queued', 'admitted'].includes(afterFirst?.status ?? ''), 'run reset for retry');

    // after retry dispatch lands, observe the retried instanceId to ok
    await wait(50);
    instanceId = manager.store.getRun(runId)!.instanceId;
    emit({ type: 'agent_end', instanceId } as FlueEvent);
    await wait(50);

    const done = manager.store.getRun(runId);
    assert.equal(done?.status, 'ok', 'retry succeeded -> ok');
    assert.equal(done?.attempt, 1, 'attempt still 1 on success');
  } finally {
    manager.stop();
    rmSync(path, { force: true });
  }
});

test('manager fire: observe timeout records timeout status', async () => {
  const fakeDispatch = async (args: DispatchScheduleArgs): Promise<ScheduleDispatchResult> => ({
    dispatchId: 'd-' + args.instanceId,
    acceptedAt: new Date().toISOString(),
    instanceId: args.instanceId,
  });
  const { manager, path } = makeManager({ dispatch: fakeDispatch, observeTimeoutMs: 30 });
  try {
    manager.store.upsert({ slug: 'timeout-test', kind: 'every', schedule: '10m', prompt: 'noop' });
    const { runId } = manager.fireNow('timeout-test')!;
    // never emit agent_end -> observe timeout (30ms) fires
    await wait(120);
    const done = manager.store.getRun(runId);
    assert.equal(done?.status, 'timeout', 'no terminal observed -> timeout recorded');
  } finally {
    manager.stop();
    rmSync(path, { force: true });
  }
});

test('manager one-shot (at) auto-deletes after run', async () => {
  const fakeDispatch = async (args: DispatchScheduleArgs): Promise<ScheduleDispatchResult> => ({
    dispatchId: 'd-' + args.instanceId,
    acceptedAt: new Date().toISOString(),
    instanceId: args.instanceId,
  });
  const { manager, emit, path } = makeManager({ dispatch: fakeDispatch });
  try {
    manager.store.upsert({
      slug: 'oneshot-test',
      kind: 'at',
      schedule: '2026-06-23T10:00:00Z',
      prompt: 'one-shot',
    });
    const sched = manager.store.getBySlug('oneshot-test');
    assert.equal(sched?.deleteAfterRun, true, 'at defaults deleteAfterRun true');
    const { runId } = manager.fireNow('oneshot-test')!;
    await wait(50);
    emit({ type: 'agent_end', instanceId: manager.store.getRun(runId)!.instanceId } as FlueEvent);
    await wait(50);
    // maybeAutoDelete runs after recordRunTerminal in the same fire path, then
    // deletes the schedule row; the FK ON DELETE CASCADE removes the run row too.
    assert.equal(manager.store.getBySlug('oneshot-test'), null, 'one-shot schedule auto-deleted after run');
    assert.equal(manager.store.getRun(runId), null, 'run row cascade-removed with the deleted one-shot');
  } finally {
    manager.stop();
    rmSync(path, { force: true });
  }
});

test('manager syncCron rehydrates enabled schedules on start and respects enabled=false', async () => {
  const fakeDispatch = async (args: DispatchScheduleArgs): Promise<ScheduleDispatchResult> => ({
    dispatchId: 'd-' + args.instanceId,
    acceptedAt: new Date().toISOString(),
    instanceId: args.instanceId,
  });
  const path = tempDbPath();
  // seed an enabled + a disabled schedule before the manager starts
  const store = new ScheduleStore(path);
  store.upsert({ slug: 'enabled', kind: 'every', schedule: '10m', prompt: 'x' });
  store.upsert({ slug: 'disabled', kind: 'every', schedule: '10m', prompt: 'x', enabled: false });
  store.close();

  const store2 = new ScheduleStore(path);
  const config = resolveScheduleConfig({}, {});
  const manager = new ScheduleManager({ store: store2, config, dispatch: fakeDispatch, observeFn: (() => () => {}) as never });
  try {
    manager.start();
    const enabled = manager.store.getBySlug('enabled');
    const disabled = manager.store.getBySlug('disabled');
    assert.ok(enabled?.nextFireAt !== null, 'enabled schedule hydrated with nextFireAt');
    assert.equal(disabled?.nextFireAt, null, 'disabled schedule has no nextFireAt');
  } finally {
    manager.stop();
    rmSync(path, { force: true });
  }
});
test('manager fire: dispatch admission failure records terminal error (not stuck queued)', async () => {
  const failingDispatch = async (): Promise<ScheduleDispatchResult> => {
    throw new Error('dispatch admission failed');
  };
  const { manager, path } = makeManager({ dispatch: failingDispatch });
  try {
    manager.store.upsert({ slug: 'fail-test', kind: 'every', schedule: '10m', prompt: 'x' });
    const { runId } = manager.fireNow('fail-test')!;
    await wait(60);
    const run = manager.store.getRun(runId);
    assert.equal(run?.status, 'error', 'dispatch failure -> terminal error, not stuck queued');
    assert.ok(run?.error?.includes('dispatch admission failed'), 'error message recorded');
  } finally {
    manager.stop();
    rmSync(path, { force: true });
  }
});

test('manager fire: agent_end emitted during dispatch admission is captured (race fix)', async () => {
  // Simulate a fast-completing turn: the fake dispatch emits agent_end BEFORE
  // resolving the receipt. With the race fix (observation registered before
  // dispatch), the event is captured -> ok. Without the fix it would be dropped
  // and the run would time out.
  let earlyEmit: (event: FlueEvent) => void = () => {};
  const earlyDispatch = async (args: DispatchScheduleArgs): Promise<ScheduleDispatchResult> => {
    earlyEmit({ type: 'agent_end', instanceId: args.instanceId } as FlueEvent);
    return { dispatchId: 'd-' + args.instanceId, acceptedAt: new Date().toISOString(), instanceId: args.instanceId };
  };
  const { manager, emit, path } = makeManager({ dispatch: earlyDispatch });
  earlyEmit = emit;
  try {
    manager.store.upsert({ slug: 'early-test', kind: 'every', schedule: '10m', prompt: 'x' });
    const { runId } = manager.fireNow('early-test')!;
    await wait(60);
    const run = manager.store.getRun(runId);
    assert.equal(run?.status, 'ok', 'early agent_end captured (not timed out)');
  } finally {
    manager.stop();
    rmSync(path, { force: true });
  }
});

test('manager fire: one-shot with transient error is NOT auto-deleted during retry', async () => {
  const fakeDispatch = async (args: DispatchScheduleArgs): Promise<ScheduleDispatchResult> => ({
    dispatchId: 'd-' + args.instanceId,
    acceptedAt: new Date().toISOString(),
    instanceId: args.instanceId,
  });
  const { manager, emit, path } = makeManager({ dispatch: fakeDispatch });
  try {
    manager.store.upsert({ slug: 'oneshot-retry', kind: 'at', schedule: '2026-06-23T10:00:00Z', prompt: 'x' });
    const { runId } = manager.fireNow('oneshot-retry')!;
    await wait(50);
    // attempt 0: transient network error -> retry scheduled; schedule must survive.
    const instanceId0 = manager.store.getRun(runId)!.instanceId;
    emit({ type: 'turn', isError: true, error: 'fetch failed: network down', instanceId: instanceId0 } as FlueEvent);
    emit({ type: 'agent_end', instanceId: instanceId0 } as FlueEvent);
    await wait(90); // backoff 10ms -> retry attempt 1 admitted
    assert.ok(manager.store.getBySlug('oneshot-retry'), 'one-shot NOT auto-deleted while a retry is pending');
    // attempt 1: ok -> NOW auto-delete (terminal, no retry pending).
    const instanceId1 = manager.store.getRun(runId)!.instanceId;
    emit({ type: 'agent_end', instanceId: instanceId1 } as FlueEvent);
    await wait(60);
    // maybeAutoDelete runs only after a terminal outcome; the schedule being
    // gone proves the retry reached terminal (ok). The run row is cascade-
    // removed with the deleted one-shot schedule, so it is no longer present.
    assert.equal(manager.store.getBySlug('oneshot-retry'), null, 'one-shot auto-deleted after terminal ok');
  } finally {
    manager.stop();
    rmSync(path, { force: true });
  }
});

test('manager fire: transient category not in config.retry.retryOn is not retried', async () => {
  const fakeDispatch = async (args: DispatchScheduleArgs): Promise<ScheduleDispatchResult> => ({
    dispatchId: 'd-' + args.instanceId, acceptedAt: new Date().toISOString(), instanceId: args.instanceId,
  });
  // makeManager config: retryOn: ['network'] only.
  const { manager, emit, path } = makeManager({ dispatch: fakeDispatch });
  try {
    manager.store.upsert({ slug: 'server-err', kind: 'every', schedule: '10m', prompt: 'x' });
    const { runId } = manager.fireNow('server-err')!;
    await wait(50);
    const instanceId = manager.store.getRun(runId)!.instanceId;
    // server_error is transient but NOT in retryOn -> terminal error, no retry.
    emit({ type: 'turn', isError: true, error: '500 server error', instanceId } as FlueEvent);
    emit({ type: 'agent_end', instanceId } as FlueEvent);
    await wait(90);
    const done = manager.store.getRun(runId);
    assert.equal(done?.status, 'error', 'server_error -> error terminal (transient)');
    assert.equal(done?.attempt, 0, 'not retried (server_error not in retryOn)');
  } finally {
    manager.stop();
    rmSync(path, { force: true });
  }
});

test('manager fire: per-schedule maxAttempts override is respected', async () => {
  const fakeDispatch = async (args: DispatchScheduleArgs): Promise<ScheduleDispatchResult> => ({
    dispatchId: 'd-' + args.instanceId, acceptedAt: new Date().toISOString(), instanceId: args.instanceId,
  });
  // makeManager global maxAttempts: 2; override this schedule to 1.
  const { manager, emit, path } = makeManager({ dispatch: fakeDispatch });
  try {
    manager.store.upsert({ slug: 'one-retry', kind: 'every', schedule: '10m', prompt: 'x', maxAttempts: 1 });
    const { runId } = manager.fireNow('one-retry')!;
    await wait(50);
    // attempt 0: network error -> retry (0 < 1, network in retryOn)
    let instanceId = manager.store.getRun(runId)!.instanceId;
    emit({ type: 'turn', isError: true, error: 'fetch failed: network down', instanceId } as FlueEvent);
    emit({ type: 'agent_end', instanceId } as FlueEvent);
    await wait(90);
    assert.equal(manager.store.getRun(runId)?.attempt, 1, 'retried once');
    // attempt 1: network error again -> 1 < 1 is false -> no retry -> terminal error
    instanceId = manager.store.getRun(runId)!.instanceId;
    emit({ type: 'turn', isError: true, error: 'fetch failed: network down', instanceId } as FlueEvent);
    emit({ type: 'agent_end', instanceId } as FlueEvent);
    await wait(90);
    const done = manager.store.getRun(runId);
    assert.equal(done?.status, 'error', 'maxAttempts=1 reached -> terminal error');
    assert.equal(done?.attempt, 1, 'no second retry');
  } finally {
    manager.stop();
    rmSync(path, { force: true });
  }
});

test('manager fire: null per-schedule maxAttempts falls back to global config', async () => {
  const fakeDispatch = async (args: DispatchScheduleArgs): Promise<ScheduleDispatchResult> => ({
    dispatchId: 'd-' + args.instanceId, acceptedAt: new Date().toISOString(), instanceId: args.instanceId,
  });
  // makeManager global maxAttempts: 2.
  const { manager, emit, path } = makeManager({ dispatch: fakeDispatch });
  try {
    manager.store.upsert({ slug: 'global-fallback', kind: 'every', schedule: '10m', prompt: 'x' });
    assert.equal(manager.store.getBySlug('global-fallback')?.maxAttempts, null, 'record maxAttempts is null');
    const { runId } = manager.fireNow('global-fallback')!;
    await wait(50);
    const instanceId = manager.store.getRun(runId)!.instanceId;
    emit({ type: 'turn', isError: true, error: 'fetch failed: network down', instanceId } as FlueEvent);
    emit({ type: 'agent_end', instanceId } as FlueEvent);
    await wait(90);
    assert.equal(manager.store.getRun(runId)?.attempt, 1, 'global maxAttempts=2 allows retry 0->1');
  } finally {
    manager.stop();
    rmSync(path, { force: true });
  }
});

test('manager: deleting a schedule cancels its pending retry (no orphaned retry dispatch)', async () => {
  let dispatchCount = 0;
  const fakeDispatch = async (args: DispatchScheduleArgs): Promise<ScheduleDispatchResult> => {
    dispatchCount += 1;
    return { dispatchId: `d-${dispatchCount}`, acceptedAt: new Date().toISOString(), instanceId: args.instanceId };
  };
  // long backoff so the retry timer is still pending when we delete
  const { manager, emit, path } = makeManager({ dispatch: fakeDispatch, backoffMs: [1000, 1000], maxAttempts: 3 });
  try {
    manager.store.upsert({ slug: 'del-retry', kind: 'every', schedule: '10m', prompt: 'x' });
    const { runId } = manager.fireNow('del-retry')!;
    await wait(50);
    const instanceId = manager.store.getRun(runId)!.instanceId;
    // transient network error -> retry scheduled with a 1000ms backoff
    emit({ type: 'turn', isError: true, error: 'fetch failed: network down', instanceId } as FlueEvent);
    emit({ type: 'agent_end', instanceId } as FlueEvent);
    await wait(30);
    assert.equal(dispatchCount, 1, 'only the initial dispatch so far');
    assert.ok(manager['cronJobs'] !== undefined, 'sanity');
    // delete the schedule while the retry backoff timer is still pending
    assert.equal(manager.deleteSchedule('del-retry'), true);
    assert.equal(manager.store.getBySlug('del-retry'), null, 'schedule deleted');
    // wait well past the 1000ms backoff; the cancelled retry must NOT dispatch
    await wait(1150);
    assert.equal(dispatchCount, 1, 'no orphaned retry dispatch after delete');
  } finally {
    manager.stop();
    rmSync(path, { force: true });
  }
});

test('manager: pausing a schedule cancels its pending retry', async () => {
  let dispatchCount = 0;
  const fakeDispatch = async (args: DispatchScheduleArgs): Promise<ScheduleDispatchResult> => {
    dispatchCount += 1;
    return { dispatchId: `d-${dispatchCount}`, acceptedAt: new Date().toISOString(), instanceId: args.instanceId };
  };
  const { manager, emit, path } = makeManager({ dispatch: fakeDispatch, backoffMs: [1000, 1000], maxAttempts: 3 });
  try {
    manager.store.upsert({ slug: 'pause-retry', kind: 'every', schedule: '10m', prompt: 'x' });
    const { runId } = manager.fireNow('pause-retry')!;
    await wait(50);
    const instanceId = manager.store.getRun(runId)!.instanceId;
    emit({ type: 'turn', isError: true, error: 'fetch failed: network down', instanceId } as FlueEvent);
    emit({ type: 'agent_end', instanceId } as FlueEvent);
    await wait(30);
    assert.equal(dispatchCount, 1);
    // pause (disable + syncCron) while the retry backoff is pending
    const paused = manager.store.setEnabled('pause-retry', false);
    manager.syncCron(paused!);
    await wait(1150);
    assert.equal(dispatchCount, 1, 'no orphaned retry dispatch after pause');
    // schedule row still present (paused, not deleted)
    assert.ok(manager.store.getBySlug('pause-retry'), 'paused schedule row retained');
  } finally {
    manager.stop();
    rmSync(path, { force: true });
  }
});

test('manager: stop() cancels pending retry timers (no retry after shutdown)', async () => {
  let dispatchCount = 0;
  const fakeDispatch = async (args: DispatchScheduleArgs): Promise<ScheduleDispatchResult> => {
    dispatchCount += 1;
    return { dispatchId: `d-${dispatchCount}`, acceptedAt: new Date().toISOString(), instanceId: args.instanceId };
  };
  const { manager, emit, path } = makeManager({ dispatch: fakeDispatch, backoffMs: [1000, 1000], maxAttempts: 3 });
  try {
    manager.store.upsert({ slug: 'stop-retry', kind: 'every', schedule: '10m', prompt: 'x' });
    const { runId } = manager.fireNow('stop-retry')!;
    await wait(50);
    const instanceId = manager.store.getRun(runId)!.instanceId;
    emit({ type: 'turn', isError: true, error: 'fetch failed: network down', instanceId } as FlueEvent);
    emit({ type: 'agent_end', instanceId } as FlueEvent);
    await wait(30);
    assert.equal(dispatchCount, 1);
    manager.stop(); // shutdown while retry backoff is pending
    await wait(1150);
    assert.equal(dispatchCount, 1, 'no orphaned retry dispatch after stop');
  } finally {
    manager.stop();
    rmSync(path, { force: true });
  }
});
