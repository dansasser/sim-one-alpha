/**
 * Focused unit test for the schedules config loader (plan §8).
 * Mirrors src/tests/memory-config.test.ts: defaults, JSON block, env overrides, duration parsing.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  backoffForAttempt,
  resolveScheduleConfig,
  type SchedulesConfig,
} from '../schedules/schedule-config.js';

test('resolveScheduleConfig applies defaults when the block is absent', () => {
  const c = resolveScheduleConfig(undefined, {});
  assert.equal(c.enabled, true);
  assert.equal(c.maxConcurrentRuns, 8);
  assert.equal(c.retry.maxAttempts, 3);
  assert.deepEqual(c.retry.backoffMs, [60_000, 120_000, 300_000]);
  assert.deepEqual(c.retry.retryOn, ['rate_limit', 'overloaded', 'network', 'server_error']);
  assert.equal(c.runLog.keepRuns, 200);
  assert.equal(c.sessionRetentionMs, 86_400_000, '24h default');
  assert.equal(c.shutdownGraceSeconds, 60);
  assert.equal(c.providerPreflight, true);
  assert.equal(c.databasePath, '.gorombo/db/schedules.sqlite');
});

test('resolveScheduleConfig reads numeric/boolean fields from the JSON block', () => {
  const c = resolveScheduleConfig(
    {
      enabled: false,
      maxConcurrentRuns: 4,
      retry: { maxAttempts: 5, backoffMs: [1_000, 2_000], retryOn: ['network'] },
      runLog: { keepRuns: 50 },
      sessionRetention: '2h',
      shutdownGraceSeconds: 30,
      providerPreflight: false,
    },
    {},
  );
  assert.equal(c.enabled, false);
  assert.equal(c.maxConcurrentRuns, 4);
  assert.equal(c.retry.maxAttempts, 5);
  assert.deepEqual(c.retry.backoffMs, [1_000, 2_000]);
  assert.deepEqual(c.retry.retryOn, ['network']);
  assert.equal(c.runLog.keepRuns, 50);
  assert.equal(c.sessionRetentionMs, 7_200_000, '2h parsed to ms');
  assert.equal(c.shutdownGraceSeconds, 30);
  assert.equal(c.providerPreflight, false);
});

test('GOROMBO_SKIP_SCHEDULES=1 disables schedules (env wins over JSON)', () => {
  const c = resolveScheduleConfig({ enabled: true }, { GOROMBO_SKIP_SCHEDULES: '1' });
  assert.equal(c.enabled, false);
});

test('GOROMBO_SCHEDULES_* env vars override the JSON config', () => {
  const c = resolveScheduleConfig(
    { maxConcurrentRuns: 4, shutdownGraceSeconds: 30 },
    {
      GOROMBO_SCHEDULES_MAX_CONCURRENT_RUNS: '16',
      GOROMBO_SCHEDULES_SHUTDOWN_GRACE_SECONDS: '90',
      GOROMBO_SCHEDULES_KEEP_RUNS: '10',
      GOROMBO_SCHEDULES_MAX_ATTEMPTS: '7',
      GOROMBO_SCHEDULES_PROVIDER_PREFLIGHT: '0',
      GOROMBO_SCHEDULES_SESSION_RETENTION: '30m',
      GOROMBO_SCHEDULES_DATABASE_PATH: '/tmp/custom-schedules.sqlite',
    },
  );
  assert.equal(c.maxConcurrentRuns, 16);
  assert.equal(c.shutdownGraceSeconds, 90);
  assert.equal(c.runLog.keepRuns, 10);
  assert.equal(c.retry.maxAttempts, 7);
  assert.equal(c.providerPreflight, false);
  assert.equal(c.sessionRetentionMs, 1_800_000, '30m parsed to ms');
  assert.equal(c.databasePath, '/tmp/custom-schedules.sqlite');
});

test('parseDurationMs accepts ms/s/m/h/d and bare numbers', () => {
  const c = (overrides: Record<string, unknown>): SchedulesConfig =>
    resolveScheduleConfig(overrides, {});
  assert.equal(c({ sessionRetention: '30m' }).sessionRetentionMs, 1_800_000);
  assert.equal(c({ sessionRetention: '2h' }).sessionRetentionMs, 7_200_000);
  assert.equal(c({ sessionRetention: '1d' }).sessionRetentionMs, 86_400_000);
  assert.equal(c({ sessionRetention: '90s' }).sessionRetentionMs, 90_000);
  assert.equal(c({ sessionRetention: 42 }).sessionRetentionMs, 42, 'bare number treated as ms');
  // malformed -> falls back to default
  assert.equal(c({ sessionRetention: 'garbage' }).sessionRetentionMs, 86_400_000);
});

test('readRetry filters invalid backoff/retryOn values and falls back to defaults when empty', () => {
  const c = resolveScheduleConfig(
    { retry: { backoffMs: [1_000, 'bad', 2_000], retryOn: ['network', 'bogus', 'server_error'] } },
    {},
  );
  assert.deepEqual(c.retry.backoffMs, [1_000, 2_000], 'non-numbers filtered');
  assert.deepEqual(c.retry.retryOn, ['network', 'server_error'], 'unknown categories filtered');
});

test('readRetry falls back to defaults when backoffMs/retryOn are empty after filtering', () => {
  const c = resolveScheduleConfig({ retry: { backoffMs: [], retryOn: [] } }, {});
  assert.deepEqual(c.retry.backoffMs, [60_000, 120_000, 300_000]);
  assert.deepEqual(c.retry.retryOn, ['rate_limit', 'overloaded', 'network', 'server_error']);
});

test('backoffForAttempt reuses the last value for attempts beyond the array length', () => {
  const retry = { maxAttempts: 3, backoffMs: [1_000, 2_000, 3_000], retryOn: ['network'] as const };
  assert.equal(backoffForAttempt(retry as never, 0), 1_000);
  assert.equal(backoffForAttempt(retry as never, 2), 3_000);
  assert.equal(backoffForAttempt(retry as never, 5), 3_000, 'later attempts reuse last value');
});
test('partial env override preserves non-overridden nested config (merge fix)', () => {
  // JSON configures retry.backoffMs and retry.retryOn; env sets ONLY keepRuns.
  // The merge must preserve retry.backoffMs / retry.retryOn from JSON.
  const c = resolveScheduleConfig(
    {
      retry: { maxAttempts: 5, backoffMs: [1_000, 2_000, 3_000], retryOn: ['network', 'server_error'] },
      runLog: { keepRuns: 99 },
    },
    { GOROMBO_SCHEDULES_KEEP_RUNS: '10' },
  );
  assert.equal(c.runLog.keepRuns, 10, 'env overrode keepRuns');
  assert.deepEqual(c.retry.backoffMs, [1_000, 2_000, 3_000], 'JSON retry.backoffMs preserved');
  assert.deepEqual(c.retry.retryOn, ['network', 'server_error'], 'JSON retry.retryOn preserved');
  assert.equal(c.retry.maxAttempts, 5, 'JSON retry.maxAttempts preserved (env did not set it)');
});

test('partial env override: maxAttempts alone does not reset runLog from JSON', () => {
  const c = resolveScheduleConfig(
    { runLog: { keepRuns: 42 }, retry: { backoffMs: [500] } },
    { GOROMBO_SCHEDULES_MAX_ATTEMPTS: '7' },
  );
  assert.equal(c.retry.maxAttempts, 7, 'env overrode maxAttempts');
  assert.equal(c.runLog.keepRuns, 42, 'JSON runLog.keepRuns preserved');
  assert.deepEqual(c.retry.backoffMs, [500], 'JSON retry.backoffMs preserved');
});

test('maxConcurrentRuns=0 (or negative) is clamped to prevent concurrency deadlock', () => {
  assert.ok(resolveScheduleConfig({ maxConcurrentRuns: 0 }, {}).maxConcurrentRuns >= 1, '0 clamped to >=1');
  assert.ok(resolveScheduleConfig({ maxConcurrentRuns: -5 }, {}).maxConcurrentRuns >= 1, 'negative clamped to >=1');
  const envClamped = resolveScheduleConfig({}, { GOROMBO_SCHEDULES_MAX_CONCURRENT_RUNS: '0' });
  assert.ok(envClamped.maxConcurrentRuns >= 1, 'env 0 clamped to >=1');
  // valid values pass through
  assert.equal(resolveScheduleConfig({ maxConcurrentRuns: 4 }, {}).maxConcurrentRuns, 4);
});

test('retry.maxAttempts<1 is clamped to >=1', () => {
  assert.ok(resolveScheduleConfig({ retry: { maxAttempts: 0 } }, {}).retry.maxAttempts >= 1, '0 clamped');
  assert.ok(resolveScheduleConfig({ retry: { maxAttempts: -2 } }, {}).retry.maxAttempts >= 1, 'negative clamped');
});
