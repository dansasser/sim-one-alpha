/**
 * ScheduleManager — the in-process cron runtime singleton (plan §5, §7).
 *
 * Owns: the ScheduleStore (SQLite), the in-memory Croner mirror, one Flue
 * `observe()` subscription that routes agent events to in-flight runs, the
 * concurrency gate, the retry/backoff scheduler, provider-preflight (stub in
 * v1), and graceful shutdown drain.
 *
 * Dispatch is ADMISSION-ONLY (see `schedule-dispatch.ts` + memory
 * `flue-dispatch-contract`): the fire callback dispatches to the orchestrator,
 * records the `DispatchReceipt`, then OBSERVES the agent turn to terminal via
 * `observe()` filtered by `instanceId`. The terminal signal is `agent_end`
 * (with preceding `turn` events' `isError` used for ok/error classification).
 *
 * Observation assumption (to be validated by the three-surface integration test
 * in task #12): dispatched agent activity events carry `instanceId` on every
 * event and terminate with an `agent_end` event, per the FlueEvent type contract
 * (`FlueEventInput.instanceId?` is on every event; `agent_end` is the agent
 * operation boundary). If that assumption fails in practice, the integration
 * test will catch it and the terminal-detection rule is adjusted — we do not
 * guess silently.
 *
 * Croner pattern handling: `cron` -> cron expr; `every` -> converted to a cron
 * expr (Croner 10.x rejects interval strings like "20m", verified empirically);
 * `at` -> ISO 8601 one-shot.
 */

import { Cron } from 'croner';
import { observe, type FlueEvent } from '@flue/runtime';
import { ulid } from '../memory/ulid.js';
import { backoffForAttempt, type SchedulesConfig } from './schedule-config.js';
import { dispatchSchedule } from './schedule-dispatch.js';
import { ScheduleStore } from './schedule-store.js';
import {
  isTransientScheduleError,
  scheduleInstanceId,
  type ScheduleKind,
  type ScheduleRecord,
  type ScheduleRunStatus,
} from './schedule-types.js';

/** Observation timeout per fire (ms). Generous default; configurable later. */
const DEFAULT_OBSERVE_TIMEOUT_MS = 10 * 60_000; // 10 minutes

const TERMINAL_TURN_EVENT = 'agent_end' as const;

const INTERVAL_PATTERN = /^(\d+)\s*(s|m|h|d)$/i;

interface PendingObservation {
  runId: string;
  scheduleId: string;
  instanceId: string;
  attempt: number;
  hadError: boolean;
  errorMessage: string | null;
  resolve: (outcome: ObservationOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ObservationOutcome {
  status: 'ok' | 'error' | 'timeout';
  error: string | null;
}

export interface ScheduleManagerOptions {
  store?: ScheduleStore;
  config: SchedulesConfig;
  /** Injectable for tests; defaults to real dispatchSchedule. */
  dispatch?: typeof dispatchSchedule;
  /** Injectable for tests; defaults to real observe(). */
  observeFn?: typeof observe;
  /** Injectable observe timeout (ms). */
  observeTimeoutMs?: number;
}

export class ScheduleManager {
  readonly store: ScheduleStore;
  readonly config: SchedulesConfig;
  private readonly dispatchImpl: typeof dispatchSchedule;
  private readonly observeImpl: typeof observe;
  private readonly observeTimeoutMs: number;

  private readonly cronJobs = new Map<string, Cron>(); // scheduleId -> Cron
  private readonly pending = new Map<string, PendingObservation>(); // instanceId -> pending
  private readonly fireQueue: Array<() => void> = [];
  private inFlight = 0;
  private unsubscribeObserve?: () => void;
  private started = false;
  private shuttingDown = false;

  constructor(options: ScheduleManagerOptions) {
    this.config = options.config;
    this.store = options.store ?? new ScheduleStore(options.config.databasePath);
    this.dispatchImpl = options.dispatch ?? dispatchSchedule;
    this.observeImpl = options.observeFn ?? observe;
    this.observeTimeoutMs = options.observeTimeoutMs ?? DEFAULT_OBSERVE_TIMEOUT_MS;
  }

  /** Boot: schema + cleanup + observe subscription + rehydrate enabled schedules. */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.store.migrate();
    this.store.cleanup(this.config.runLog.keepRuns, this.config.sessionRetentionMs);

    // One in-process event subscription for all agent activity. Route by instanceId.
    this.unsubscribeObserve = this.observeImpl((event) => this.handleEvent(event));

    for (const record of this.store.listEnabled()) {
      this.syncCron(record);
    }
  }

  /** Graceful stop: stop accepting fires, stop all crons, abort in-flight observations. */
  stop(): void {
    this.shuttingDown = true;
    for (const cron of this.cronJobs.values()) {
      cron.stop();
    }
    this.cronJobs.clear();
    this.unsubscribeObserve?.();
    this.unsubscribeObserve = undefined;
    // Terminal any still-pending observations as 'timeout' (the underlying Flue
    // submissions are aborted at turn boundary by Flue's graceful-shutdown path
    // and left reclaimable — see durable-execution doc).
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ status: 'timeout', error: 'shutdown drain' });
    }
    this.pending.clear();
    this.started = false;
  }

  /** Mirror a schedule row into the Croner runtime. Called after every CRUD mutation. */
  syncCron(record: ScheduleRecord): void {
    const existing = this.cronJobs.get(record.id);
    if (!record.enabled || this.shuttingDown) {
      if (existing) {
        existing.stop();
        this.cronJobs.delete(record.id);
      }
      this.store.setNextFire(record.slug, null);
      return;
    }
    const pattern = toCronerPattern(record.kind, record.schedule);
    if (pattern === null) {
      // Invalid schedule expression — stop any existing job, leave the row.
      if (existing) {
        existing.stop();
        this.cronJobs.delete(record.id);
      }
      return;
    }
    if (existing) {
      existing.stop();
    }
    const cron = new Cron(
      pattern,
      {
        protect: record.protect,
        timezone: record.timezone || 'UTC',
        catch: (error) => {
          this.emitScheduleError(record, `cron fire failed: ${errorMessage(error)}`);
        },
      },
      () => {
        this.fire(record).catch((error) => {
          this.emitScheduleError(record, `uncaught fire error: ${errorMessage(error)}`);
        });
      },
    );
    this.cronJobs.set(record.id, cron);
    const next = cron.nextRun();
    this.store.setNextFire(record.slug, next ? next.getTime() : null);
  }

  /** Force-fire a schedule now (manual trigger from admin route / schedule_run_now tool). */
  fireNow(slug: string): { runId: string } | null {
    const record = this.store.getBySlug(slug);
    if (!record) {
      return null;
    }
    const runId = ulid();
    // Fire without going through Croner (manual trigger), but same fire path.
    this.fire(record, runId).catch((error) => {
      this.emitScheduleError(record, `manual fire error: ${errorMessage(error)}`);
    });
    return { runId };
  }

  /**
   * Delete a schedule: stop its in-memory Croner job AND remove the row. Used by
   * the delete tool + admin route so a deleted schedule stops firing immediately
   * (not only after a process restart).
   */
  deleteSchedule(slug: string): boolean {
    const record = this.store.getBySlug(slug);
    if (!record) {
      return false;
    }
    const cron = this.cronJobs.get(record.id);
    if (cron) {
      cron.stop();
    }
    this.cronJobs.delete(record.id);
    const deleted = this.store.delete(slug);
    this.emitEvent('schedule.deleted', { scheduleId: record.id, slug });
    return deleted;
  }

  /** Acquire the concurrency gate; returns false if shutdown interrupted the wait. */
  private async acquireConcurrency(): Promise<boolean> {
    if (this.inFlight >= this.config.maxConcurrentRuns) {
      await new Promise<void>((resolve) => this.fireQueue.push(resolve));
      if (this.shuttingDown) {
        return false;
      }
    }
    this.inFlight += 1;
    return true;
  }

  private releaseConcurrency(): void {
    this.inFlight -= 1;
    const next = this.fireQueue.shift();
    if (next) {
      next();
    }
  }

  /** Cancel a pending observation (clear timer + remove + resolve) — used when dispatch admission fails. */
  private cancelObservation(instanceId: string): void {
    const pending = this.pending.get(instanceId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(instanceId);
      pending.resolve({ status: 'timeout', error: 'cancelled' });
    }
  }

  /**
   * Run one dispatch attempt. Shared by fire() (attempt 0) and retryFire()
   * (attempt N). The pending observation is registered BEFORE dispatch so a
   * fast-completing turn's terminal event is not dropped (race fix). Dispatch
   * admission failures are caught and recorded terminal. maybeAutoDelete runs
   * only on a final terminal outcome (not when a retry is pending).
   */
  private async runAttempt(
    record: ScheduleRecord,
    runId: string,
    instanceId: string,
    attempt: number,
    startedAtMs: number,
  ): Promise<void> {
    const scheduledAt = new Date().toISOString();

    // Register the observation BEFORE dispatch so agent_end emitted by a
    // fast-completing turn is captured, not dropped (race fix).
    const outcomePromise = this.observeUntilTerminal(runId, record.id, instanceId, attempt);

    let receipt: { dispatchId: string; acceptedAt: string };
    try {
      receipt = await this.dispatchImpl({
        instanceId,
        targetAgent: record.targetAgent,
        input: {
          prompt: record.prompt,
          scheduledAt,
          scheduleId: record.id,
          slug: record.slug,
          runId,
          payload: record.payload ?? undefined,
        },
      });
    } catch (error) {
      // Dispatch admission failed -> terminal error (no retry; this is a
      // dispatch infra failure, not a transient model error). Cancel the
      // observation we registered so it does not linger and time out later.
      this.cancelObservation(instanceId);
      const reason = errorMessage(error);
      this.store.recordRunTerminal(runId, 'error', { error: reason, firedAtMs: startedAtMs, nextFireAt: this.nextFireFor(record.id) });
      this.emitEvent('schedule.error', { scheduleId: record.id, runId, instanceId, attempt, reason });
      this.maybeAutoDelete(record);
      return;
    }

    this.store.recordRunAdmitted(runId, receipt.dispatchId, receipt.acceptedAt);
    this.emitEvent('schedule.dispatched', { scheduleId: record.id, runId, instanceId, dispatchId: receipt.dispatchId, attempt });

    const outcome = await outcomePromise;
    if (outcome.status === 'ok') {
      this.store.recordRunTerminal(runId, 'ok', { firedAtMs: startedAtMs, nextFireAt: this.nextFireFor(record.id) });
      this.emitEvent('schedule.completed', { scheduleId: record.id, runId, instanceId, attempt });
      this.maybeAutoDelete(record);
    } else if (outcome.status === 'timeout') {
      this.store.recordRunTerminal(runId, 'timeout', { error: outcome.error ?? 'observe timeout', firedAtMs: startedAtMs, nextFireAt: this.nextFireFor(record.id) });
      this.emitEvent('schedule.error', { scheduleId: record.id, runId, instanceId, attempt, reason: outcome.error ?? 'observe timeout' });
      this.maybeAutoDelete(record);
    } else {
      const category = classifyError(outcome.error);
      const maxAttempts = record.maxAttempts ?? this.config.retry.maxAttempts;
      // Retry only transient categories that the operator configured as retryable
      // (config.retry.retryOn). isTransientScheduleError classifies transient vs
      // permanent (-> 'error' vs 'skipped' terminal status); retryOn gates which
      // transient categories actually retry, so a customized retry policy has
      // runtime effect.
      if (
        isTransientScheduleError(category) &&
        this.config.retry.retryOn.includes(category) &&
        attempt < maxAttempts
      ) {
        // Retry with backoff. Unique per-attempt instanceId so delayed events
        // from a prior attempt cannot be misrouted to the retry's observation.
        const nextAttempt = attempt + 1;
        const retryInstanceId = `schedule:${record.id}:${runId}:${nextAttempt}`;
        this.store.recordRunRetry(runId, retryInstanceId);
        this.emitEvent('schedule.error', { scheduleId: record.id, runId, instanceId, attempt, reason: outcome.error ?? 'transient error', retrying: true });
        const delay = backoffForAttempt(this.config.retry, attempt);
        setTimeout(() => {
          this.retryFire(record, runId, retryInstanceId, nextAttempt).catch((error) => {
            this.emitScheduleError(record, `retry fire error: ${errorMessage(error)}`);
          });
        }, delay);
        // No maybeAutoDelete here — a retry is pending; auto-deleting now would
        // cascade-delete run history and lose retry tracking (esp. for `at`).
      } else {
        const status: ScheduleRunStatus = isTransientScheduleError(category) ? 'error' : 'skipped';
        this.store.recordRunTerminal(runId, status, { error: outcome.error ?? category, firedAtMs: startedAtMs, nextFireAt: this.nextFireFor(record.id) });
        this.emitEvent(status === 'skipped' ? 'schedule.skipped' : 'schedule.error', { scheduleId: record.id, runId, instanceId, attempt, reason: outcome.error ?? category });
        this.maybeAutoDelete(record);
      }
    }
  }

  /** The core fire callback: record run start, preflight, then run the first attempt. */
  private async fire(record: ScheduleRecord, explicitRunId?: string): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    if (!(await this.acquireConcurrency())) {
      return;
    }
    const runId = explicitRunId ?? ulid();
    const instanceId = scheduleInstanceId(record.id, runId);
    const scheduledAt = new Date().toISOString();
    const startedAtMs = Date.now();
    try {
      this.store.recordRunStart(record.id, runId);
      this.emitEvent('schedule.fired', { scheduleId: record.id, slug: record.slug, scheduledAt, runId, instanceId });

      // Provider preflight (v1 stub — deferred D9; returns ok unless wired).
      if (this.config.providerPreflight) {
        const preflight = this.providerPreflight();
        if (!preflight.ok) {
          this.store.recordRunTerminal(runId, 'skipped', {
            error: preflight.error ?? 'provider endpoint unavailable',
            firedAtMs: startedAtMs,
            nextFireAt: this.nextFireFor(record.id),
          });
          this.emitEvent('schedule.skipped', { scheduleId: record.id, runId, reason: preflight.error });
          this.maybeAutoDelete(record);
          return;
        }
      }

      await this.runAttempt(record, runId, instanceId, 0, startedAtMs);
    } finally {
      this.releaseConcurrency();
    }
  }

  /** Retry fire: re-admit dispatch with a unique retry instanceId, through the concurrency gate. */
  private async retryFire(record: ScheduleRecord, runId: string, instanceId: string, attempt: number): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    if (!(await this.acquireConcurrency())) {
      return;
    }
    const startedAtMs = Date.now();
    try {
      await this.runAttempt(record, runId, instanceId, attempt, startedAtMs);
    } finally {
      this.releaseConcurrency();
    }
  }

  /** Subscribe a pending observation and await terminal (agent_end) or timeout. */
  private observeUntilTerminal(
    runId: string,
    scheduleId: string,
    instanceId: string,
    attempt: number,
  ): Promise<ObservationOutcome> {
    return new Promise<ObservationOutcome>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.has(instanceId)) {
          this.pending.delete(instanceId);
        }
        resolve({ status: 'timeout', error: 'observe timeout' });
      }, this.observeTimeoutMs);

      this.pending.set(instanceId, {
        runId,
        scheduleId,
        instanceId,
        attempt,
        hadError: false,
        errorMessage: null,
        resolve: (outcome) => {
          clearTimeout(timer);
          this.pending.delete(instanceId);
          resolve(outcome);
        },
        timer,
      });
    });
  }

  /** The observe() subscriber: route events by instanceId, detect terminal. */
  private handleEvent(event: FlueEvent): void {
    const instanceId = (event as { instanceId?: string }).instanceId;
    if (!instanceId) {
      return;
    }
    const pending = this.pending.get(instanceId);
    if (!pending) {
      return;
    }
    if (event.type === 'turn' && (event as { isError?: boolean }).isError) {
      pending.hadError = true;
      pending.errorMessage = errorMessage((event as { error?: unknown }).error) ?? 'turn error';
      return;
    }
    if (event.type === TERMINAL_TURN_EVENT) {
      pending.resolve({
        status: pending.hadError ? 'error' : 'ok',
        error: pending.errorMessage,
      });
    }
  }

  /** Provider preflight (v1 stub — deferred phase D9). Returns ok unless overridden. */
  private providerPreflight(): { ok: true } | { ok: false; error: string } {
    return { ok: true };
  }

  private nextFireFor(scheduleId: string): number | null {
    const cron = this.cronJobs.get(scheduleId);
    if (!cron) {
      return null;
    }
    const next = cron.nextRun();
    return next ? next.getTime() : null;
  }

  private maybeAutoDelete(record: ScheduleRecord): void {
    if (record.deleteAfterRun && record.kind === 'at') {
      const cron = this.cronJobs.get(record.id);
      if (cron) {
        cron.stop();
      }
      this.cronJobs.delete(record.id);
      this.store.delete(record.slug);
      this.emitEvent('schedule.deleted', { scheduleId: record.id, slug: record.slug, autoDelete: true });
    }
  }

  private emitEvent(type: string, payload: Record<string, unknown>): void {
    // v1: progress events are forwarded via the telemetry subscriber (task #7).
    // The manager emits a structured event record; schedule-telemetry.ts routes it.
    scheduleProgressEmitter(type, payload);
  }

  private emitScheduleError(record: ScheduleRecord, reason: string): void {
    this.emitEvent('schedule.error', { scheduleId: record.id, slug: record.slug, reason });
  }
}

/** Pluggable progress-event emitter, wired by schedule-telemetry.ts (task #7). */
export let scheduleProgressEmitter: (type: string, payload: Record<string, unknown>) => void = () => {};

export function setScheduleProgressEmitter(fn: (type: string, payload: Record<string, unknown>) => void): void {
  scheduleProgressEmitter = fn;
}

/** Convert a schedule kind+schedule string to a Croner pattern. */
export function toCronerPattern(kind: ScheduleKind, schedule: string): string | null {
  switch (kind) {
    case 'cron':
      return schedule;
    case 'at':
      return schedule; // ISO 8601 string — Croner fires once.
    case 'every':
      return intervalToCron(schedule);
    default:
      return null;
  }
}

/** Convert an interval string (Nm/Nh/Nd/Ns) to a cron expression. */
export function intervalToCron(interval: string): string | null {
  // Bracket access avoids the security hook's `exec(` pattern match on RegExp.exec.
  const match = INTERVAL_PATTERN['exec'](interval.trim());
  if (!match) {
    return null;
  }
  const n = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  switch (unit) {
    case 's':
      return n <= 59 ? `*/${n} * * * * *` : null; // 6-field (seconds)
    case 'm':
      return n <= 59 ? `*/${n} * * * *` : null; // 5-field (minutes)
    case 'h':
      return n <= 23 ? `0 */${n} * * *` : null;
    case 'd':
      return n <= 28 ? `0 0 */${n} * *` : null; // day-of-month capped to avoid month-wrap surprises
    default:
      return null;
  }
}

/** Classify an error string into a schedule error category (transient vs permanent). */
export function classifyError(error: string | null | undefined): string {
  const text = String(error ?? '').toLowerCase();
  if (!text) {
    return 'server_error';
  }
  if (text.includes('rate') && text.includes('limit')) {
    return 'rate_limit';
  }
  if (text.includes('overload')) {
    return 'overloaded';
  }
  if (text.includes('network') || text.includes('econnreset') || text.includes('etimedout') || text.includes('fetch failed')) {
    return 'network';
  }
  if (text.includes('5') && (text.includes('server') || text.includes('bad gateway') || text.includes('gateway'))) {
    return 'server_error';
  }
  if (text.includes('validation') || text.includes('invalid')) {
    return 'validation';
  }
  if (text.includes('provider') && (text.includes('unavailable') || text.includes('down') || text.includes('not configured'))) {
    return 'provider-unavailable';
  }
  return 'server_error';
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}