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

import { resolveScheduleConfig } from '../schedules/schedule-config.js';
import type { DispatchScheduleArgs, ScheduleDispatchResult } from '../schedules/schedule-dispatch.js';
import { ScheduleStore } from '../schedules/schedule-store.js';
import {
  ScheduleManager,
  classifyError,
  intervalToCron,
  toCronerPattern,
} from '../schedules/schedule-manager.js';
import type { ScheduleKind } from '../schedules/schedule-types.js';

function tempDbPath(): string {
  return `/tmp/sim-one-schedules-mgr-${Date.now()}-${Math.floor(Math.random() * 1e6)}.sqlite`;
}

function makeManager({
  dispatch,
  observeTimeoutMs = 5000,
}: {
  dispatch: (args: DispatchScheduleArgs) => Promise<ScheduleDispatchResult>;
  observeTimeoutMs?: number;
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
    { maxConcurrentRuns: 2, retry: { maxAttempts: 2, backoffMs: [10, 20], retryOn: ['network'] } },
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