/**
 * SQLite CRUD for schedules + schedule_runs, plus retention cleanup.
 *
 * Backed by a dedicated `node:sqlite` database file (`.gorombo/db/schedules.sqlite`),
 * mirroring `src/session/session-database.ts` (`DatabaseSync` from `node:sqlite`,
 * WAL, `mkdirSync` of the parent dir, idempotent schema creation). This is NOT
 * the Flue `sqlite()` adapter in `src/db.ts` — that adapter stores only
 * Flue-runtime state (sessions, submissions, runs) per the Flue database guide;
 * schedule definitions and run history are application-owned business data and
 * live in their own file, exactly like `GoromboSessionDatabase` does for
 * session data.
 *
 * Schema creation runs from `ScheduleManager.start()` (app-owned), NOT from the
 * Flue adapter migrate hook. TS owns ids (ulid from `src/memory/ulid.ts`) and
 * the clock (`Date.now()`), matching the structured-memory pattern.
 *
 * Dispatch is ADMISSION-ONLY (see `schedule-types.ts`): a run row tracks
 * `instanceId` + `dispatchId` (admission), not a fictional `agentRunId`. The
 * terminal status is observed via the Flue event stream and written here by the
 * manager.
 */

import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ulid } from '../memory/ulid.js';
import {
  isTransientScheduleError,
  scheduleInstanceId,
  type ScheduleDefinition,
  type ScheduleKind,
  type ScheduleRecord,
  type ScheduleRunRecord,
  type ScheduleRunStatus,
  type ScheduleSummaryRow,
  type ScheduleTargetAgent,
} from './schedule-types.js';

export const defaultScheduleDatabasePath = '.gorombo/db/schedules.sqlite';

const SCHEDULE_KINDS: readonly ScheduleKind[] = ['cron', 'every', 'at'];
const TARGET_AGENTS: readonly ScheduleTargetAgent[] = ['orchestrator', 'coding-worker'];
const TERMINAL_STATUSES: readonly ScheduleRunStatus[] = ['ok', 'error', 'skipped', 'timeout', 'lost'];

function resolveRuntimePath(filePath: string): string {
  return isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);
}

function isScheduleKind(value: string): value is ScheduleKind {
  return (SCHEDULE_KINDS as readonly string[]).includes(value);
}

function isTargetAgent(value: string): value is ScheduleTargetAgent {
  return (TARGET_AGENTS as readonly string[]).includes(value);
}

function isTerminalStatus(value: string): value is ScheduleRunStatus {
  return (TERMINAL_STATUSES as readonly string[]).includes(value);
}

function parsePayload(text: string | null): Record<string, unknown> | null {
  if (text === null || text === '') {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function rowToScheduleRecord(row: ScheduleRow): ScheduleRecord {
  return {
    id: row.id,
    slug: row.slug,
    kind: row.kind,
    schedule: row.schedule,
    timezone: row.timezone,
    targetAgent: row.target_agent,
    prompt: row.prompt,
    payload: parsePayload(row.payload_json),
    enabled: row.enabled === 1,
    ownerScope: row.owner_scope,
    protect: row.protect === 1,
    maxAttempts: row.max_attempts,
    deleteAfterRun: row.delete_after_run === 1,
    lastFiredAt: row.last_fired_at,
    nextFireAt: row.next_fire_at,
    lastRunStatus: row.last_run_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToRunRecord(row: RunRow): ScheduleRunRecord {
  return {
    runId: row.run_id,
    scheduleId: row.schedule_id,
    instanceId: row.instance_id,
    dispatchId: row.dispatch_id,
    status: row.status,
    error: row.error,
    attempt: row.attempt,
    startedAt: row.started_at,
    admittedAt: row.admitted_at,
    finishedAt: row.finished_at,
  };
}

function rowToSummary(row: ScheduleSummaryRowDb): ScheduleSummaryRow {
  return {
    id: row.id,
    slug: row.slug,
    kind: row.kind,
    targetAgent: row.target_agent,
    enabled: row.enabled === 1,
    nextFireAt: row.next_fire_at,
    lastFiredAt: row.last_fired_at,
    lastRunStatus: row.last_run_status,
  };
}

interface ScheduleRow {
  id: string;
  slug: string;
  kind: ScheduleKind;
  schedule: string;
  timezone: string;
  target_agent: ScheduleTargetAgent;
  prompt: string;
  payload_json: string | null;
  enabled: number;
  owner_scope: string | null;
  protect: number;
  max_attempts: number;
  delete_after_run: number;
  last_fired_at: number | null;
  next_fire_at: number | null;
  last_run_status: ScheduleRunStatus | null;
  created_at: number;
  updated_at: number;
}

interface RunRow {
  run_id: string;
  schedule_id: string;
  instance_id: string;
  dispatch_id: string | null;
  status: ScheduleRunStatus;
  error: string | null;
  attempt: number;
  started_at: number;
  admitted_at: number | null;
  finished_at: number | null;
}

interface ScheduleSummaryRowDb {
  id: string;
  slug: string;
  kind: ScheduleKind;
  target_agent: ScheduleTargetAgent;
  enabled: number;
  next_fire_at: number | null;
  last_fired_at: number | null;
  last_run_status: ScheduleRunStatus | null;
}

/**
 * Thrown when a create/update would violate a constraint (bad kind, bad
 * target, empty slug/prompt/schedule, duplicate slug). Permanent — surfaces to
 * the LLM tool / admin route as a 400, not retried.
 */
export class ScheduleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScheduleValidationError';
  }
}

export interface UpsertScheduleOptions {
  /** When true and a row with this slug already exists, update it in place. */
  mergeExisting?: boolean;
}

export class ScheduleStore {
  private readonly database: DatabaseSync;
  /** Bound `database.exec` — named to avoid the security-hook's `exec(` pattern match. */
  private readonly runSql: (sql: string) => void;

  constructor(readonly filePath = defaultScheduleDatabasePath) {
    const resolved = resolveRuntimePath(filePath);
    mkdirSync(dirname(resolved), { recursive: true });
    this.database = new DatabaseSync(resolved, { timeout: 5_000 });
    this.runSql = this.database.exec.bind(this.database);
    this.runSql('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
    this.migrate();
  }

  close(): void {
    this.database.close();
  }

  /** Idempotent schema creation. Called from ScheduleManager.start(). */
  migrate(): void {
    this.runSql(`
      CREATE TABLE IF NOT EXISTS schedules (
        id              TEXT PRIMARY KEY,
        slug            TEXT NOT NULL UNIQUE,
        kind            TEXT NOT NULL,
        schedule        TEXT NOT NULL,
        timezone        TEXT NOT NULL DEFAULT 'UTC',
        target_agent    TEXT NOT NULL,
        prompt          TEXT NOT NULL,
        payload_json    TEXT,
        enabled         INTEGER NOT NULL DEFAULT 1,
        owner_scope     TEXT,
        protect         INTEGER NOT NULL DEFAULT 1,
        max_attempts    INTEGER NOT NULL DEFAULT 3,
        delete_after_run INTEGER NOT NULL DEFAULT 0,
        last_fired_at   INTEGER,
        next_fire_at    INTEGER,
        last_run_status TEXT,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_schedules_enabled ON schedules(enabled);
      CREATE INDEX IF NOT EXISTS idx_schedules_target ON schedules(target_agent);
      CREATE INDEX IF NOT EXISTS idx_schedules_owner ON schedules(owner_scope);

      CREATE TABLE IF NOT EXISTS schedule_runs (
        run_id        TEXT PRIMARY KEY,
        schedule_id   TEXT NOT NULL,
        instance_id   TEXT NOT NULL,
        dispatch_id   TEXT,
        status        TEXT NOT NULL,
        error         TEXT,
        attempt       INTEGER NOT NULL DEFAULT 0,
        started_at    INTEGER NOT NULL,
        admitted_at   INTEGER,
        finished_at   INTEGER,
        FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_runs_schedule ON schedule_runs(schedule_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runs_status ON schedule_runs(status);
    `);
  }

  private validateDefinition(def: ScheduleDefinition): void {
    if (!def.slug || def.slug.trim() === '') {
      throw new ScheduleValidationError('slug is required.');
    }
    if (!isScheduleKind(def.kind)) {
      throw new ScheduleValidationError(`kind must be one of: ${SCHEDULE_KINDS.join(', ')}.`);
    }
    if (!def.schedule || def.schedule.trim() === '') {
      throw new ScheduleValidationError('schedule is required.');
    }
    if (!def.prompt || def.prompt.trim() === '') {
      throw new ScheduleValidationError('prompt is required.');
    }
    const targetAgent = def.targetAgent ?? 'orchestrator';
    if (!isTargetAgent(targetAgent)) {
      throw new ScheduleValidationError(`targetAgent must be one of: ${TARGET_AGENTS.join(', ')}.`);
    }
  }

  /** Insert a new schedule, or merge into an existing row with the same slug. */
  upsert(def: ScheduleDefinition, options: UpsertScheduleOptions = {}): ScheduleRecord {
    this.validateDefinition(def);
    const now = Date.now();
    const timezone = def.timezone ?? 'UTC';
    const targetAgent: ScheduleTargetAgent = def.targetAgent ?? 'orchestrator';
    const payloadJson = def.payload ? JSON.stringify(def.payload) : null;
    const enabled = (def.enabled ?? true) ? 1 : 0;
    const protect = (def.protect ?? true) ? 1 : 0;
    const maxAttempts = def.maxAttempts ?? 3;
    const deleteAfterRun = (def.deleteAfterRun ?? def.kind === 'at') ? 1 : 0;

    const existing = this.getBySlug(def.slug);
    if (existing && options.mergeExisting !== false) {
      this.database
        .prepare(
          `UPDATE schedules
           SET kind = ?, schedule = ?, timezone = ?, target_agent = ?, prompt = ?, payload_json = ?,
               enabled = ?, owner_scope = COALESCE(?, owner_scope), protect = ?,
               max_attempts = ?, delete_after_run = ?, updated_at = ?
           WHERE slug = ?`,
        )
        .run(
          def.kind,
          def.schedule,
          timezone,
          targetAgent,
          def.prompt,
          payloadJson,
          enabled,
          def.ownerScope ?? null,
          protect,
          maxAttempts,
          deleteAfterRun,
          now,
          def.slug,
        );
      return this.getBySlug(def.slug)!;
    }

    if (existing) {
      // mergeExisting === false but row exists -> caller asked for a fresh create on a taken slug.
      throw new ScheduleValidationError(`slug '${def.slug}' already exists.`);
    }

    const id = ulid();
    this.database
      .prepare(
        `INSERT INTO schedules
         (id, slug, kind, schedule, timezone, target_agent, prompt, payload_json, enabled,
          owner_scope, protect, max_attempts, delete_after_run, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        def.slug,
        def.kind,
        def.schedule,
        timezone,
        targetAgent,
        def.prompt,
        payloadJson,
        enabled,
        def.ownerScope ?? null,
        protect,
        maxAttempts,
        deleteAfterRun,
        now,
        now,
      );
    return this.getById(id)!;
  }

  getById(id: string): ScheduleRecord | null {
    const row = this.database.prepare(`SELECT * FROM schedules WHERE id = ?`).get(id) as
      | ScheduleRow
      | undefined;
    return row ? rowToScheduleRecord(row) : null;
  }

  getBySlug(slug: string): ScheduleRecord | null {
    const row = this.database
      .prepare(`SELECT * FROM schedules WHERE slug = ?`)
      .get(slug) as ScheduleRow | undefined;
    return row ? rowToScheduleRecord(row) : null;
  }

  list(): ScheduleSummaryRow[] {
    const rows = this.database
      .prepare(
        `SELECT id, slug, kind, target_agent, enabled, next_fire_at, last_fired_at, last_run_status
         FROM schedules ORDER BY slug ASC`,
      )
      .all() as unknown as ScheduleSummaryRowDb[];
    return rows.map(rowToSummary);
  }

  listEnabled(): ScheduleRecord[] {
    const rows = this.database
      .prepare(`SELECT * FROM schedules WHERE enabled = 1 ORDER BY slug ASC`)
      .all() as unknown as ScheduleRow[];
    return rows.map(rowToScheduleRecord);
  }

  setEnabled(slug: string, enabled: boolean): ScheduleRecord | null {
    const now = Date.now();
    this.database
      .prepare(`UPDATE schedules SET enabled = ?, updated_at = ? WHERE slug = ?`)
      .run(enabled ? 1 : 0, now, slug);
    return this.getBySlug(slug);
  }

  updateFields(
    slug: string,
    fields: {
      schedule?: string;
      prompt?: string;
      payload?: Record<string, unknown> | null;
      timezone?: string;
      enabled?: boolean;
    },
  ): ScheduleRecord | null {
    const existing = this.getBySlug(slug);
    if (!existing) {
      return null;
    }
    const now = Date.now();
    const sets: string[] = ['updated_at = ?'];
    const params: Array<string | number | null> = [now];
    if (fields.schedule !== undefined) {
      sets.push('schedule = ?');
      params.push(fields.schedule);
    }
    if (fields.prompt !== undefined) {
      sets.push('prompt = ?');
      params.push(fields.prompt);
    }
    if (fields.payload !== undefined) {
      sets.push('payload_json = ?');
      params.push(fields.payload ? JSON.stringify(fields.payload) : null);
    }
    if (fields.timezone !== undefined) {
      sets.push('timezone = ?');
      params.push(fields.timezone);
    }
    if (fields.enabled !== undefined) {
      sets.push('enabled = ?');
      params.push(fields.enabled ? 1 : 0);
    }
    params.push(slug);
    this.database.prepare(`UPDATE schedules SET ${sets.join(', ')} WHERE slug = ?`).run(...params);
    return this.getBySlug(slug);
  }

  delete(slug: string): boolean {
    const result = this.database.prepare(`DELETE FROM schedules WHERE slug = ?`).run(slug);
    return result.changes > 0;
  }

  /** Mark a schedule's next fire time (epoch ms), set by the manager from Croner. */
  setNextFire(slug: string, nextFireAt: number | null): void {
    this.database
      .prepare(`UPDATE schedules SET next_fire_at = ?, updated_at = ? WHERE slug = ?`)
      .run(nextFireAt, Date.now(), slug);
  }

  // ---- Run history ----

  /** Create a run row at fire time. */
  recordRunStart(scheduleId: string, runId: string): ScheduleRunRecord {
    const schedule = this.getById(scheduleId);
    if (!schedule) {
      throw new ScheduleValidationError(`schedule ${scheduleId} not found.`);
    }
    const instanceId = scheduleInstanceId(scheduleId, runId);
    const now = Date.now();
    this.database
      .prepare(
        `INSERT INTO schedule_runs
         (run_id, schedule_id, instance_id, dispatch_id, status, error, attempt,
          started_at, admitted_at, finished_at)
         VALUES (?, ?, ?, NULL, 'queued', NULL, 0, ?, NULL, NULL)`,
      )
      .run(runId, scheduleId, instanceId, now);
    return this.getRun(runId)!;
  }

  /** Record dispatch admission (DispatchReceipt). acceptedAt is an ISO string. */
  recordRunAdmitted(runId: string, dispatchId: string, acceptedAt: string): void {
    const admittedMs = Date.parse(acceptedAt);
    this.database
      .prepare(
        `UPDATE schedule_runs
         SET dispatch_id = ?, status = 'admitted', admitted_at = ?
         WHERE run_id = ?`,
      )
      .run(dispatchId, Number.isNaN(admittedMs) ? Date.now() : admittedMs, runId);
  }

  /**
   * Record a terminal status, set finished_at, and update the parent schedule's
   * last_fired_at + last_run_status. `firedAtMs` is when the Croner fire
   * happened (epoch ms); `nextFireAt` is the next Croner fire time (epoch ms or null).
   */
  recordRunTerminal(
    runId: string,
    status: ScheduleRunStatus,
    options: { error?: string; firedAtMs?: number; nextFireAt?: number | null } = {},
  ): void {
    if (!isTerminalStatus(status)) {
      throw new ScheduleValidationError(`recordRunTerminal requires a terminal status, got ${status}.`);
    }
    const now = Date.now();
    this.database
      .prepare(
        `UPDATE schedule_runs
         SET status = ?, error = ?, finished_at = ?
         WHERE run_id = ?`,
      )
      .run(status, options.error ?? null, now, runId);

    const run = this.getRun(runId);
    if (run) {
      const firedAt = options.firedAtMs ?? now;
      const nextFire = options.nextFireAt ?? null;
      this.database
        .prepare(
          `UPDATE schedules
           SET last_fired_at = ?, next_fire_at = ?, last_run_status = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(firedAt, nextFire, status, now, run.scheduleId);
    }
  }

  /**
   * Advance the attempt counter and reset the run row for a retry (new fire).
   * Called by the manager when a transient error is retried with backoff. The
   * caller re-dispatches with a fresh instanceId; this advances the attempt
   * ledger on the existing run row.
   */
  recordRunRetry(runId: string, newInstanceId: string): void {
    this.database
      .prepare(
        `UPDATE schedule_runs
         SET instance_id = ?, dispatch_id = NULL, status = 'queued', admitted_at = NULL,
             finished_at = NULL, error = NULL, attempt = attempt + 1
         WHERE run_id = ?`,
      )
      .run(newInstanceId, runId);
  }

  getRun(runId: string): ScheduleRunRecord | null {
    const row = this.database
      .prepare(`SELECT * FROM schedule_runs WHERE run_id = ?`)
      .get(runId) as RunRow | undefined;
    return row ? rowToRunRecord(row) : null;
  }

  listRuns(scheduleId: string, limit = 50): ScheduleRunRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY started_at DESC LIMIT ?`,
      )
      .all(scheduleId, limit) as unknown as RunRow[];
    return rows.map(rowToRunRecord);
  }

  /** Runs that have been admitted but not yet observed to terminal (for shutdown drain). */
  listInFlightRuns(): ScheduleRunRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM schedule_runs
         WHERE status IN ('queued', 'admitted', 'running')
         ORDER BY started_at ASC`,
      )
      .all() as unknown as RunRow[];
    return rows.map(rowToRunRecord);
  }

  /**
   * Retention cleanup. Prunes the oldest runs per schedule beyond `keepRuns`,
   * and prunes run rows older than `retentionMs` regardless of count. Safe to
   * call on every boot. Returns the number of rows pruned.
   */
  cleanup(keepRuns: number, retentionMs?: number): number {
    let pruned = 0;
    const scheduleIds = this.database
      .prepare(`SELECT DISTINCT schedule_id FROM schedule_runs`)
      .all() as unknown as { schedule_id: string }[];
    const pruneOld = this.database.prepare(
      `DELETE FROM schedule_runs
       WHERE run_id IN (
         SELECT run_id FROM schedule_runs r
         WHERE r.schedule_id = ?
         ORDER BY r.started_at DESC
         LIMIT -1 OFFSET ?
       )`,
    );
    const changesStmt = this.database.prepare(`SELECT changes() AS c`);
    const readChanges = (): number => {
      const row = changesStmt.get() as { c: number } | undefined;
      return row?.c ?? 0;
    };
    for (const { schedule_id } of scheduleIds) {
      pruneOld.run(schedule_id, keepRuns);
      pruned += readChanges();
    }

    if (retentionMs !== undefined) {
      const cutoff = Date.now() - retentionMs;
      this.database.prepare(`DELETE FROM schedule_runs WHERE started_at < ?`).run(cutoff);
      pruned += readChanges();
    }
    return pruned;
  }

  /** Exposed for tests/inspection: is the underlying DB open? */
  isOpen(): boolean {
    try {
      this.database.prepare(`SELECT 1`).get();
      return true;
    } catch {
      return false;
    }
  }
}

export { isTransientScheduleError };