import { observe, type FlueEvent } from '@flue/runtime';

export interface TelemetryEventSummary {
  type: FlueEvent['type'];
  timestamp?: string;
  eventIndex?: number;
  runId?: string;
  harness?: string;
  session?: string;
  parentSession?: string;
  taskId?: string;
  operationId?: string;
  turnId?: string;
  agent?: string;
  toolName?: string;
  operationKind?: string;
  durationMs?: number;
  isError?: boolean;
  usage?: {
    input?: number;
    output?: number;
    totalTokens?: number;
  };
}

export interface TelemetryRunSummary {
  runId: string;
  eventCount: number;
  delegatedToResearcher: boolean;
  calledWebResearch: boolean;
  taskStarts: TelemetryEventSummary[];
  toolCalls: TelemetryEventSummary[];
  operations: TelemetryEventSummary[];
  errors: TelemetryEventSummary[];
  events: TelemetryEventSummary[];
}

export interface TelemetrySnapshot {
  runs: TelemetryRunSummary[];
  unscopedEventCount: number;
}

/**
 * Sanitized record of a structured-memory mutation (checklist/todo/note
 * create/update/delete). No record content body is kept - only id, kind, scope
 * keys, tool name, run id, agent, and updatedBy. Per plan §Observability.
 */
export interface MemoryMutationEvent {
  type: 'memory_mutation';
  timestamp: string;
  toolName: string;
  runId?: string;
  agentName: string;
  recordId: string;
  kind: 'checklist' | 'todo' | 'session_note';
  scopeKeys: {
    actorId?: string;
    conversationId?: string;
    projectId?: string;
    threadId?: string;
    global?: boolean;
  };
  updatedBy: string;
}

export interface MemoryMutationSnapshot {
  mutations: MemoryMutationEvent[];
}

/**
 * Keeps a bounded in-memory summary of sanitized Flue events.
 *
 * A synchronous mutation lock serializes `record`, `reset`, and trimming work
 * inside this module instance, including observer callbacks that enter through
 * `record`. JavaScript worker threads do not share this store instance.
 */
export class FlueTelemetryStore {
  private readonly eventsByRunId = new Map<string, TelemetryEventSummary[]>();
  private readonly unscopedEvents: TelemetryEventSummary[] = [];
  private readonly memoryMutations: MemoryMutationEvent[] = [];
  private readonly pendingMutations: Array<() => void> = [];
  private mutationLocked = false;

  constructor(
    private readonly options: {
      maxRuns?: number;
      maxEventsPerRun?: number;
      maxUnscopedEvents?: number;
      maxMemoryMutations?: number;
    } = {},
  ) {}

  /**
   * Records one sanitized event summary and trims bounded buffers immediately.
   */
  record(event: FlueEvent): void {
    this.withMutationLock(() => {
      this.recordLocked(event);
    });
  }

  /**
   * Records a sanitized structured-memory mutation (no content body).
   */
  recordMemoryMutation(event: MemoryMutationEvent): void {
    this.withMutationLock(() => {
      // Deep-copy on record so callers cannot mutate the audit log entry
      // after it is recorded.
      this.memoryMutations.push(structuredClone(event));
      trimArray(this.memoryMutations, this.options.maxMemoryMutations ?? 500);
    });
  }

  /**
   * Returns the bounded memory-mutation audit log (no record content).
   */
  memoryMutationSnapshot(): MemoryMutationSnapshot {
    // Deep-clone each entry so snapshot consumers cannot modify the originals.
    return { mutations: this.memoryMutations.map((event) => structuredClone(event)) };
  }

  /**
   * Applies one event mutation while the telemetry mutation lock is held.
   */
  private recordLocked(event: FlueEvent): void {
    const summary = summarizeFlueEvent(event);
    if (!summary) {
      return;
    }

    if (!summary.runId) {
      this.unscopedEvents.push(summary);
      trimArray(this.unscopedEvents, this.options.maxUnscopedEvents ?? 200);
      return;
    }

    const events = this.eventsByRunId.get(summary.runId) ?? [];
    events.push(summary);
    trimArray(events, this.options.maxEventsPerRun ?? 500);
    this.eventsByRunId.set(summary.runId, events);
    this.trimRuns();
  }

  /**
   * Returns the current summary for a run without exposing prompt or tool payloads.
   */
  getRunSummary(runId: string): TelemetryRunSummary | undefined {
    const events = this.eventsByRunId.get(runId);
    return events ? summarizeRun(runId, events) : undefined;
  }

  /**
   * Returns all bounded run summaries and the count of events that had no run id.
   */
  snapshot(): TelemetrySnapshot {
    return {
      runs: [...this.eventsByRunId.entries()].map(([runId, events]) => summarizeRun(runId, events)),
      unscopedEventCount: this.unscopedEvents.length,
    };
  }

  /**
   * Clears all captured telemetry, primarily for tests.
   */
  reset(): void {
    this.withMutationLock(() => {
      this.eventsByRunId.clear();
      this.unscopedEvents.length = 0;
      this.memoryMutations.length = 0;
    });
  }

  /**
   * Runs one mutation at a time and queues reentrant calls until the lock is released.
   */
  private withMutationLock(mutation: () => void): void {
    if (this.mutationLocked) {
      this.pendingMutations.push(mutation);
      return;
    }

    this.mutationLocked = true;
    try {
      mutation();
      let pendingMutation = this.pendingMutations.shift();
      while (pendingMutation) {
        pendingMutation();
        pendingMutation = this.pendingMutations.shift();
      }
    } finally {
      this.mutationLocked = false;
    }
  }

  /**
   * Trims oldest runs while the telemetry mutation lock is held.
   */
  private trimRuns(): void {
    const maxRuns = this.options.maxRuns ?? 100;
    while (this.eventsByRunId.size > maxRuns) {
      const oldestRunId = this.eventsByRunId.keys().next().value as string | undefined;
      if (!oldestRunId) {
        return;
      }
      this.eventsByRunId.delete(oldestRunId);
    }
  }
}

export const flueTelemetryStore = new FlueTelemetryStore();

/**
 * Record a structured-memory mutation on the singleton telemetry store. Called
 * by mutating Memory Helper tools after a successful write. Keeps no content.
 */
export function recordMemoryMutationEvent(event: MemoryMutationEvent): void {
  flueTelemetryStore.recordMemoryMutation(event);
}

/**
 * Builds a sanitized telemetry summary from a persisted Flue run event stream.
 */
export function summarizeTelemetryRunFromEvents(runId: string, events: unknown[]): TelemetryRunSummary | undefined {
  const summaries = events
    .filter(isFlueEvent)
    .map((event) => summarizeFlueEvent(event))
    .filter((event): event is TelemetryEventSummary => Boolean(event));

  if (!summaries.length) {
    return undefined;
  }

  return summarizeRun(runId, summaries);
}

function isFlueEvent(event: unknown): event is FlueEvent {
  return typeof event === 'object' &&
    event !== null &&
    !Array.isArray(event) &&
    typeof (event as { type?: unknown }).type === 'string';
}

let observerUnsubscribe: (() => void) | undefined;

/**
 * Registers the singleton telemetry observer once for the current module instance.
 */
export function registerFlueTelemetryObserver(): void {
  if (observerUnsubscribe) {
    return;
  }

  observerUnsubscribe = observe((event) => {
    // The store serializes observer callback mutations through `record`.
    flueTelemetryStore.record(event);
  });
}

/**
 * Builds a run-level summary from sanitized events.
 */
function summarizeRun(runId: string, events: TelemetryEventSummary[]): TelemetryRunSummary {
  const taskStarts = events.filter((event) => event.type === 'task_start');
  const toolCalls = events.filter((event) =>
    event.type === 'tool_start' ||
    event.type === 'tool',
  );
  const operations = events.filter((event) => event.type === 'operation_start' || event.type === 'operation');
  const errors = events.filter((event) => event.isError);

  return {
    runId,
    eventCount: events.length,
    delegatedToResearcher: taskStarts.some((event) => event.agent === 'researcher'),
    calledWebResearch: toolCalls.some((event) => event.toolName === 'web_research'),
    taskStarts,
    toolCalls,
    operations,
    errors,
    events,
  };
}

/**
 * Converts a Flue event into the fields safe enough to expose from telemetry.
 */
function summarizeFlueEvent(event: FlueEvent): TelemetryEventSummary | undefined {
  if (!shouldKeepEvent(event)) {
    return undefined;
  }

  return {
    type: event.type,
    timestamp: event.timestamp,
    eventIndex: event.eventIndex,
    runId: event.runId,
    harness: event.harness,
    session: event.session,
    parentSession: event.parentSession,
    taskId: event.taskId,
    operationId: event.operationId,
    turnId: event.turnId,
    agent: readEventString(event, 'agent'),
    toolName: readEventString(event, 'toolName'),
    operationKind: readEventString(event, 'operationKind'),
    durationMs: readEventNumber(event, 'durationMs'),
    isError: readEventBoolean(event, 'isError'),
    usage: readUsage(event),
  };
}

/**
 * Keeps only event types useful for delegation, tool-use, operation, and error summaries.
 */
function shouldKeepEvent(event: FlueEvent): boolean {
  return [
    'run_start',
    'run_end',
    'agent_start',
    'agent_end',
    'turn_start',
    'turn',
    'tool_start',
    'tool',
    'task_start',
    'task',
    'operation_start',
    'operation',
    'compaction_start',
    'compaction',
    'log',
  ].includes(event.type);
}

/**
 * Extracts token counts while dropping provider cost and message content details.
 */
function readUsage(event: FlueEvent): TelemetryEventSummary['usage'] {
  const usage = 'usage' in event ? event.usage : undefined;
  if (!usage) {
    return undefined;
  }

  return {
    input: usage.input,
    output: usage.output,
    totalTokens: usage.totalTokens,
  };
}

/**
 * Reads a string property from Flue's event union without broadening the public type.
 */
function readEventString(event: FlueEvent, key: string): string | undefined {
  const value = (event as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Reads a finite numeric property from Flue's event union.
 */
function readEventNumber(event: FlueEvent, key: string): number | undefined {
  const value = (event as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Reads a boolean property from Flue's event union.
 */
function readEventBoolean(event: FlueEvent, key: string): boolean | undefined {
  const value = (event as Record<string, unknown>)[key];
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Removes oldest entries from an array until it fits the configured maximum.
 */
function trimArray<T>(values: T[], maxLength: number): void {
  if (values.length > maxLength) {
    values.splice(0, values.length - maxLength);
  }
}
