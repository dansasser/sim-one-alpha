/**
 * Structured progress events for the schedules subsystem (plan §11).
 *
 * Mirrors the coding-worker event pattern
 * (`src/workers/coding-worker/events/coding-worker-events.ts`): a typed event
 * union, a factory that stamps the timestamp, a public-safety assert that
 * rejects private model context (thinking/chain-of-thought), and a bounded
 * in-memory reporter.
 *
 * The manager emits these via the pluggable `scheduleProgressEmitter` (see
 * `schedule-manager.ts`); `installScheduleTelemetry()` wires that emitter to a
 * `ScheduleProgressReporter`.
 *
 * v1 scope: events are typed, collected in a bounded in-memory reporter, and
 * exposable via the admin route / telemetry snapshot. The scheduled turn's
 * actual OUTPUT reaches the user through the orchestrator's response (the same
 * path chat ingress uses). Full durable persistence + connector push of the
 * `schedule.*` lifecycle events (plan §11 "routable through the connector
 * layer") is a follow-up; v1 makes them typed + routable (collected + exposable)
 * which is the substantive part.
 */

import { setScheduleProgressEmitter } from './schedule-manager.js';

export type ScheduleProgressEventType =
  | 'schedule.fired'
  | 'schedule.dispatched'
  | 'schedule.completed'
  | 'schedule.error'
  | 'schedule.skipped'
  | 'schedule.created'
  | 'schedule.paused'
  | 'schedule.resumed'
  | 'schedule.updated'
  | 'schedule.deleted'
  | 'schedule.shutdown';

export interface ScheduleProgressEvent {
  type: ScheduleProgressEventType;
  timestamp: string;
  scheduleId?: string;
  slug?: string;
  runId?: string;
  instanceId?: string;
  dispatchId?: string;
  scheduledAt?: string;
  attempt?: number;
  retrying?: boolean;
  autoDelete?: boolean;
  reason?: string;
  status?: string;
}

const forbiddenPublicTraceKeys = new Set([
  'thinking',
  'chainOfThought',
  'chain_of_thought',
  'rawThinking',
  'rawPrompt',
  'internalPrompt',
]);

function findForbiddenKey(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (forbiddenPublicTraceKeys.has(key)) {
      return key;
    }
    if (child && typeof child === 'object') {
      const nested = findForbiddenKey(child);
      if (nested) {
        return nested;
      }
    }
  }
  return undefined;
}

export function assertPublicScheduleEvent(event: ScheduleProgressEvent): void {
  const unsafeKey = findForbiddenKey(event);
  if (unsafeKey) {
    throw new Error(`Public schedule events must not expose private model context: ${unsafeKey}`);
  }
}

export function createScheduleEvent(
  type: ScheduleProgressEventType,
  payload: Record<string, unknown>,
): ScheduleProgressEvent {
  const event = {
    type,
    timestamp: new Date().toISOString(),
    ...payload,
  } as ScheduleProgressEvent;
  assertPublicScheduleEvent(event);
  return event;
}

export interface ScheduleProgressReporter {
  emit(event: ScheduleProgressEvent): void;
  events(): ScheduleProgressEvent[];
  recent(limit?: number): ScheduleProgressEvent[];
  clear(): void;
}

export class InMemoryScheduleProgressReporter implements ScheduleProgressReporter {
  readonly #events: ScheduleProgressEvent[] = [];
  readonly #maxEvents: number;

  constructor(maxEvents = 500) {
    this.#maxEvents = maxEvents;
  }

  emit(event: ScheduleProgressEvent): void {
    this.#events.push(event);
    if (this.#events.length > this.#maxEvents) {
      this.#events.splice(0, this.#events.length - this.#maxEvents);
    }
  }

  events(): ScheduleProgressEvent[] {
    return [...this.#events];
  }

  recent(limit = 50): ScheduleProgressEvent[] {
    return this.#events.slice(-limit);
  }

  clear(): void {
    this.#events.length = 0;
  }
}

let installedReporter: ScheduleProgressReporter | undefined;

/**
 * Wire the manager's pluggable progress emitter to a reporter. Call once from
 * the schedules boot path (task #8). Returns the reporter for inspection.
 */
export function installScheduleTelemetry(
  reporter: ScheduleProgressReporter = new InMemoryScheduleProgressReporter(),
): ScheduleProgressReporter {
  installedReporter = reporter;
  setScheduleProgressEmitter((type, payload) => {
    try {
      reporter.emit(createScheduleEvent(type as ScheduleProgressEventType, payload));
    } catch {
      // Telemetry must never break the schedule fire path.
    }
  });
  return reporter;
}

/** Access the installed reporter (e.g. from the admin route to surface recent activity). */
export function getScheduleProgressReporter(): ScheduleProgressReporter | undefined {
  return installedReporter;
}