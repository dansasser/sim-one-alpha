/**
 * Shared type contracts for the schedules subsystem.
 *
 * Schedules add recurring / one-shot agent execution to SIM-ONE Alpha as a
 * standalone product: schedule definitions + run history are durable in
 * SQLite (app-owned `node:sqlite` file `.gorombo/db/schedules.sqlite`); firing
 * uses Croner in-process; on restart, Croner jobs are rehydrated from SQLite.
 *
 * Dispatch is ADMISSION-ONLY (verified five ways 2026-06-22; see
 * memory `flue-dispatch-contract`). `dispatch(...)` returns a `DispatchReceipt`
 * with only `{ dispatchId, acceptedAt }` — it is not a workflow runId and the
 * agent turn runs asynchronously in the agent's durable queue. The terminal
 * status is observed in-process via `observe()` filtered by `dispatchId`. These
 * types encode that contract: a run row tracks `instanceId` + `dispatchId`
 * (admission), not a fictional `agentRunId`.
 *
 * See `/opt/ai/plans/schedules/plan.md` (§4 schedule kinds, §6 schema, §7 flow).
 */

/** Schedule kinds borrowed from OpenClaw, validated by Croner. */
export type ScheduleKind = 'cron' | 'every' | 'at';

/**
 * Target agent key. v1 schedules dispatch to the orchestrator or the
 * coding-worker lead. The column is free-form so a future `target_kind`
 * extension (workflow dispatch) is non-breaking (plan deferred phase D2).
 */
export type ScheduleTargetAgent = 'orchestrator' | 'coding-worker';

/**
 * Run status lifecycle.
 *
 * `queued`    — Croner fired; run row created before dispatch admission.
 * `admitted`  — dispatch() resolved with a DispatchReceipt (admission only;
 *               the agent turn now runs async in the agent's durable queue).
 * `running`   — terminal observation in flight (reserved; `admitted` and
 *               `running` are often interchangeable in v1).
 * `ok`        — a terminal turn-success event was observed via observe().
 * `error`     — a terminal turn-error event was observed (non-retryable, or
 *               retries exhausted).
 * `skipped`   — permanent failure (validation/provider-unavailable) or
 *               provider-preflight down; NOT retried.
 * `timeout`   — observation did not reach terminal before the shutdown grace
 *               window closed.
 * `lost`      — run orphaned (process died mid-observe) and not reconciled.
 */
export type ScheduleRunStatus =
  | 'queued'
  | 'admitted'
  | 'running'
  | 'ok'
  | 'error'
  | 'skipped'
  | 'timeout'
  | 'lost';

/**
 * Transient error categories eligible for retry with backoff. Permanent
 * failures (validation / provider-unavailable) are classified as `skipped`
 * and are NOT retried — matches OpenClaw so a dead local model produces
 * `skipped` rather than a retry storm (plan §8).
 */
export type ScheduleTransientErrorCategory =
  | 'rate_limit'
  | 'overloaded'
  | 'network'
  | 'server_error';

/** Permanent (non-retried) error categories. */
export type SchedulePermanentErrorCategory = 'validation' | 'provider-unavailable';

/**
 * Input delivered to the target agent via Flue `dispatch(...)`.
 *
 * `type: 'schedule'` distinguishes scheduled input from chat/connector ingress
 * (per the Flue schedules guide). `scheduledAt` is the ISO timestamp the
 * schedule was due (Croner fire time), not the admission time. Extra
 * `payloadJson` fields merge into the dispatch input as-is (model/thinking/
 * tools-allowlist passthrough — plan deferred phase D8).
 */
export interface ScheduleRunInput {
  type: 'schedule';
  prompt: string;
  scheduledAt: string;
  scheduleId: string;
  slug: string;
  runId: string;
  /** The agent instance id passed to dispatch (`id` field). Unique per fire. */
  instanceId: string;
  /**
   * Intended handler. v1 always dispatches to the orchestrator (the only
   * Flue-discovered agent); for 'coding-worker' the orchestrator delegates to
   * the coding-worker subagent via its task tool (see schedule-dispatch.ts).
   */
  targetAgent: ScheduleTargetAgent;
  /** Optional extra dispatch input fields merged from `schedules.payload_json`. */
  payload?: Record<string, unknown>;
}

/**
 * Schedule definition as supplied by a create/update caller (LLM tool or admin
 * HTTP route). The store generates `id` (ulid) and timestamps; callers never
 * supply them (TS owns ids/clock — mirrors the structured-memory pattern in
 * `src/memory`).
 */
export interface ScheduleDefinition {
  slug: string;
  kind: ScheduleKind;
  /** Cron expression (`cron`), interval string like "20m"/"1h" (`every`), or ISO 8601 / relative timestamp (`at`). */
  schedule: string;
  timezone?: string;
  targetAgent?: ScheduleTargetAgent;
  prompt: string;
  /** Optional extra dispatch input fields (model, thinking, tools allowlist, etc.). Stored as JSON text. */
  payload?: Record<string, unknown>;
  enabled?: boolean;
  /**
   * Derived from the trusted eventId (per the Tools auth-boundary rule, plan §2).
   * Injected by trusted code, never model-selected.
   */
  ownerScope?: string;
  /** Croner overlap protection. Default true. */
  protect?: boolean;
  maxAttempts?: number;
  /** One-shot default true when kind='at'. Auto-delete the row after the run. */
  deleteAfterRun?: boolean;
}

/**
 * A schedule row as persisted in SQLite. Mirrors `ScheduleDefinition` plus
 * id/timestamps and runtime tracking columns. This is the durable source of
 * truth that Croner jobs rehydrate from on boot.
 */
export interface ScheduleRecord {
  id: string;
  slug: string;
  kind: ScheduleKind;
  schedule: string;
  timezone: string;
  targetAgent: ScheduleTargetAgent;
  prompt: string;
  /** Parsed payload object (deserialized from `payload_json` text column). */
  payload: Record<string, unknown> | null;
  enabled: boolean;
  ownerScope: string | null;
  protect: boolean;
  /**
   * Per-schedule retry budget override, or null when the caller did not set one
   * (in which case the manager falls back to the global `config.retry.maxAttempts`).
   * Stored nullable so the global config is actually consulted, not silently
   * shadowed by a hardcoded per-row default.
   */
  maxAttempts: number | null;
  deleteAfterRun: boolean;
  lastFiredAt: number | null;
  nextFireAt: number | null;
  lastRunStatus: ScheduleRunStatus | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * A `schedule_runs` row — the durable run history (OpenClaw keeps the same).
 * Used for three-surface verification (plan §12), `cron runs`-style
 * inspection, and retention cleanup.
 *
 * NOTE: there is no `agentRunId`. Flue `dispatch(...)` to an agent does not
 * produce a workflow run id; it returns a `dispatchId` that correlates one
 * accepted delivery. The terminal status is observed via the Flue event
 * stream, not returned by dispatch.
 */
export interface ScheduleRunRecord {
  runId: string;
  scheduleId: string;
  /** Agent instance id passed to dispatch (unique per fire, e.g. `schedule:<scheduleId>:<runId>`). */
  instanceId: string;
  /** Flue `DispatchReceipt.dispatchId` (correlates one accepted delivery; NOT a workflow runId). */
  dispatchId: string | null;
  status: ScheduleRunStatus;
  error: string | null;
  attempt: number;
  startedAt: number;
  /** From `DispatchReceipt.acceptedAt`. Null until dispatch admits. */
  admittedAt: number | null;
  finishedAt: number | null;
}

/** Compact row shape returned by `schedule_list` / `GET /api/schedules`. */
export interface ScheduleSummaryRow {
  id: string;
  slug: string;
  kind: ScheduleKind;
  targetAgent: ScheduleTargetAgent;
  enabled: boolean;
  nextFireAt: number | null;
  lastFiredAt: number | null;
  lastRunStatus: ScheduleRunStatus | null;
}

/**
 * Construct the deterministic per-fire agent instance id. Using a unique id per
 * fire gives each scheduled turn its own isolated, observable agent instance
 * stream (plan §15 — isolated per-run sessions in v1).
 */
export function scheduleInstanceId(scheduleId: string, runId: string): string {
  return `schedule:${scheduleId}:${runId}`;
}

/** Classify an observed terminal error into transient (retry) vs permanent (skip). */
export function isTransientScheduleError(
  category: ScheduleTransientErrorCategory | SchedulePermanentErrorCategory | string,
): category is ScheduleTransientErrorCategory {
  return (
    category === 'rate_limit' ||
    category === 'overloaded' ||
    category === 'network' ||
    category === 'server_error'
  );
}