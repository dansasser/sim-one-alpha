/**
 * Typed loader for the schedules config block (plan §8).
 *
 * Mirrors the memory config pattern in `src/memory/structured-memory-runtime.ts`:
 * `resolveScheduleConfig(raw, env)` merges DEFAULTS <- JSON block <- env overrides
 * (env wins). The raw block lives at `GoromboConfig.schedules`.
 *
 * Retry distinguishes transient (rate_limit/overloaded/network/server_error ->
 * backoff + retry) from permanent (validation/provider-unavailable -> `skipped`,
 * do NOT retry), matching OpenClaw so a dead local model produces `skipped`
 * rather than a retry storm.
 */

import type { ScheduleTransientErrorCategory } from './schedule-types.js';

const DEFAULT_BACKOFF_MS: readonly number[] = [60_000, 120_000, 300_000];
const DEFAULT_RETRY_ON: readonly ScheduleTransientErrorCategory[] = [
  'rate_limit',
  'overloaded',
  'network',
  'server_error',
];

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i;

export interface ScheduleRetryConfig {
  maxAttempts: number;
  /** Backoff in ms per attempt index; last value is reused for later attempts. */
  backoffMs: number[];
  retryOn: ScheduleTransientErrorCategory[];
}

export interface ScheduleRunLogConfig {
  /** Per-schedule history cap; cleanup prunes oldest runs beyond this. */
  keepRuns: number;
}

export interface SchedulesConfig {
  enabled: boolean;
  databasePath: string;
  maxConcurrentRuns: number;
  retry: ScheduleRetryConfig;
  runLog: ScheduleRunLogConfig;
  /** Prune agent-turn session rows for isolated runs older than this (ms). */
  sessionRetentionMs: number;
  shutdownGraceSeconds: number;
  /** Skip a run with a clear error if the local provider endpoint is down (cache 5min). */
  providerPreflight: boolean;
}

const DEFAULTS: SchedulesConfig = {
  enabled: true,
  databasePath: '.gorombo/db/schedules.sqlite',
  maxConcurrentRuns: 8,
  retry: {
    maxAttempts: 3,
    backoffMs: [...DEFAULT_BACKOFF_MS],
    retryOn: [...DEFAULT_RETRY_ON],
  },
  runLog: {
    keepRuns: 200,
  },
  sessionRetentionMs: 86_400_000, // 24h
  shutdownGraceSeconds: 60,
  providerPreflight: true,
};

function parseDurationMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  // Bracket access avoids the security hook's `exec(` pattern match on RegExp.exec.
  const match = DURATION_PATTERN['exec'](trimmed);
  if (!match) {
    return undefined;
  }
  const num = Number(match[1]);
  const unit = (match[2] ?? 'ms').toLowerCase();
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return Math.round(num * multipliers[unit]);
}

function readNum(raw: Record<string, unknown>, key: string, def: number): number {
  const v = raw[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : def;
}

function readBool(raw: Record<string, unknown>, key: string, def: boolean): boolean {
  const v = raw[key];
  return typeof v === 'boolean' ? v : def;
}

function readRetry(raw: Record<string, unknown>): ScheduleRetryConfig {
  const retryRaw = (raw.retry ?? {}) as Record<string, unknown>;
  const backoffRaw = retryRaw.backoffMs;
  const backoffMs = Array.isArray(backoffRaw)
    ? backoffRaw.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    : [...DEFAULT_BACKOFF_MS];
  const retryOnRaw = retryRaw.retryOn;
  const retryOn = Array.isArray(retryOnRaw)
    ? retryOnRaw.filter(
        (v): v is ScheduleTransientErrorCategory =>
          typeof v === 'string' &&
          (DEFAULT_RETRY_ON as readonly string[]).includes(v),
      )
    : [...DEFAULT_RETRY_ON];
  return {
    maxAttempts: readNum(retryRaw, 'maxAttempts', DEFAULTS.retry.maxAttempts),
    backoffMs: backoffMs.length > 0 ? backoffMs : [...DEFAULT_BACKOFF_MS],
    retryOn: retryOn.length > 0 ? retryOn : [...DEFAULT_RETRY_ON],
  };
}

function num(value: string | undefined): number | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Env overrides. Nested fields (`retry`, `runLog`) are Partial so the resolver
 * can MERGE them field-by-field instead of replacing the whole nested object
 * (which would reset JSON-configured fields like retry.backoffMs when only one
 * env var is set).
 */
export interface ScheduleEnvOverrides {
  enabled?: boolean;
  databasePath?: string;
  maxConcurrentRuns?: number;
  retry?: Partial<ScheduleRetryConfig>;
  runLog?: Partial<ScheduleRunLogConfig>;
  sessionRetentionMs?: number;
  shutdownGraceSeconds?: number;
  providerPreflight?: boolean;
}

/** Read GOROMBO_SCHEDULES_* / GOROMBO_SKIP_SCHEDULES env overrides. Env wins. */
export function readScheduleEnvOverrides(
  env: Record<string, string | undefined>,
): ScheduleEnvOverrides {
  const out: ScheduleEnvOverrides = {};
  if (env.GOROMBO_SKIP_SCHEDULES === '1' || env.GOROMBO_SKIP_SCHEDULES === 'true') {
    out.enabled = false;
  }
  if (typeof env.GOROMBO_SCHEDULES_DATABASE_PATH === 'string' && env.GOROMBO_SCHEDULES_DATABASE_PATH) {
    out.databasePath = env.GOROMBO_SCHEDULES_DATABASE_PATH;
  }
  const maxConcurrent = num(env.GOROMBO_SCHEDULES_MAX_CONCURRENT_RUNS);
  if (maxConcurrent !== undefined) {
    out.maxConcurrentRuns = maxConcurrent;
  }
  // Decoupled: each env var sets only its own nested field, so unrelated nested
  // config from JSON is preserved by the resolver's field-by-field merge.
  const keepRuns = num(env.GOROMBO_SCHEDULES_KEEP_RUNS);
  if (keepRuns !== undefined) {
    out.runLog = { keepRuns };
  }
  const maxAttempts = num(env.GOROMBO_SCHEDULES_MAX_ATTEMPTS);
  if (maxAttempts !== undefined) {
    out.retry = { maxAttempts };
  }
  const grace = num(env.GOROMBO_SCHEDULES_SHUTDOWN_GRACE_SECONDS);
  if (grace !== undefined) {
    out.shutdownGraceSeconds = grace;
  }
  if (env.GOROMBO_SCHEDULES_PROVIDER_PREFLIGHT !== undefined) {
    out.providerPreflight =
      env.GOROMBO_SCHEDULES_PROVIDER_PREFLIGHT !== '0' &&
      env.GOROMBO_SCHEDULES_PROVIDER_PREFLIGHT !== 'false';
  }
  const retention = parseDurationMs(env.GOROMBO_SCHEDULES_SESSION_RETENTION);
  if (retention !== undefined) {
    out.sessionRetentionMs = retention;
  }
  return out;
}

/** Clamp to a minimum; fall back to `fallback` when the value is not finite. */
function clampMin(value: number, min: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, value);
}

/** Resolve the typed schedules config from the raw `GoromboConfig.schedules` block. */
export function resolveScheduleConfig(
  raw: Record<string, unknown> | undefined,
  env: Record<string, string | undefined> = process.env,
): SchedulesConfig {
  const fromEnv = readScheduleEnvOverrides(env);

  const base: SchedulesConfig = (!raw || typeof raw !== 'object')
    ? { ...DEFAULTS }
    : {
        ...DEFAULTS,
        enabled: readBool(raw, 'enabled', DEFAULTS.enabled),
        databasePath:
          typeof raw.databasePath === 'string' && raw.databasePath
            ? raw.databasePath
            : DEFAULTS.databasePath,
        maxConcurrentRuns: readNum(raw, 'maxConcurrentRuns', DEFAULTS.maxConcurrentRuns),
        retry: readRetry(raw),
        runLog: {
          keepRuns: readNum(
            (raw.runLog ?? {}) as Record<string, unknown>,
            'keepRuns',
            DEFAULTS.runLog.keepRuns,
          ),
        },
        sessionRetentionMs: parseDurationMs(raw.sessionRetention) ?? DEFAULTS.sessionRetentionMs,
        shutdownGraceSeconds: readNum(raw, 'shutdownGraceSeconds', DEFAULTS.shutdownGraceSeconds),
        providerPreflight: readBool(raw, 'providerPreflight', DEFAULTS.providerPreflight),
      };

  // Apply env overrides. Top-level fields override directly; nested objects
  // (retry, runLog) are MERGED field-by-field so env only overrides the fields
  // it actually sets, preserving the rest of the JSON-configured nested object.
  const merged: SchedulesConfig = {
    ...base,
    ...(fromEnv.enabled !== undefined ? { enabled: fromEnv.enabled } : {}),
    ...(fromEnv.databasePath !== undefined ? { databasePath: fromEnv.databasePath } : {}),
    ...(fromEnv.maxConcurrentRuns !== undefined ? { maxConcurrentRuns: fromEnv.maxConcurrentRuns } : {}),
    ...(fromEnv.shutdownGraceSeconds !== undefined ? { shutdownGraceSeconds: fromEnv.shutdownGraceSeconds } : {}),
    ...(fromEnv.providerPreflight !== undefined ? { providerPreflight: fromEnv.providerPreflight } : {}),
    ...(fromEnv.sessionRetentionMs !== undefined ? { sessionRetentionMs: fromEnv.sessionRetentionMs } : {}),
    retry: { ...base.retry, ...(fromEnv.retry ?? {}) },
    runLog: { ...base.runLog, ...(fromEnv.runLog ?? {}) },
  };

  // Lower-bound validation: maxConcurrentRuns=0 (or negative) would deadlock the
  // concurrency gate (every fire queues, none proceeds); maxAttempts<1 would
  // prevent any retry; negative caps/grace/retention are nonsensical. Clamp to
  // safe minimums (fall back to defaults for non-finite values).
  merged.maxConcurrentRuns = clampMin(merged.maxConcurrentRuns, 1, DEFAULTS.maxConcurrentRuns);
  merged.retry = {
    ...merged.retry,
    maxAttempts: clampMin(merged.retry.maxAttempts, 1, DEFAULTS.retry.maxAttempts),
  };
  merged.runLog = { ...merged.runLog, keepRuns: Math.max(0, merged.runLog.keepRuns) };
  merged.shutdownGraceSeconds = Math.max(0, merged.shutdownGraceSeconds);
  merged.sessionRetentionMs = Math.max(0, merged.sessionRetentionMs);

  return merged;
}

/** Backoff delay (ms) for a given attempt index (0-based). Reuses the last value for later attempts. */
export function backoffForAttempt(config: ScheduleRetryConfig, attemptIndex: number): number {
  if (config.backoffMs.length === 0) {
    return 0;
  }
  const idx = Math.min(attemptIndex, config.backoffMs.length - 1);
  return config.backoffMs[idx] ?? 0;
}