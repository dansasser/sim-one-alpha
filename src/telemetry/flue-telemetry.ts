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

export class FlueTelemetryStore {
  private readonly eventsByRunId = new Map<string, TelemetryEventSummary[]>();
  private readonly unscopedEvents: TelemetryEventSummary[] = [];

  constructor(
    private readonly options: {
      maxRuns?: number;
      maxEventsPerRun?: number;
      maxUnscopedEvents?: number;
    } = {},
  ) {}

  record(event: FlueEvent): void {
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

  getRunSummary(runId: string): TelemetryRunSummary | undefined {
    const events = this.eventsByRunId.get(runId);
    return events ? summarizeRun(runId, events) : undefined;
  }

  snapshot(): TelemetrySnapshot {
    return {
      runs: [...this.eventsByRunId.entries()].map(([runId, events]) => summarizeRun(runId, events)),
      unscopedEventCount: this.unscopedEvents.length,
    };
  }

  reset(): void {
    this.eventsByRunId.clear();
    this.unscopedEvents.length = 0;
  }

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

let observerRegistered = false;

export function registerFlueTelemetryObserver(): void {
  if (observerRegistered) {
    return;
  }

  observe((event) => {
    flueTelemetryStore.record(event);
  });
  observerRegistered = true;
}

function summarizeRun(runId: string, events: TelemetryEventSummary[]): TelemetryRunSummary {
  const taskStarts = events.filter((event) => event.type === 'task_start');
  const toolCalls = events.filter((event) =>
    event.type === 'tool_start' ||
    event.type === 'tool_call' ||
    event.type === 'tool_execution_start' ||
    event.type === 'tool_execution_end',
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

function shouldKeepEvent(event: FlueEvent): boolean {
  return [
    'run_start',
    'run_end',
    'agent_start',
    'agent_end',
    'turn_start',
    'turn',
    'tool_start',
    'tool_call',
    'tool_execution_start',
    'tool_execution_end',
    'task_start',
    'task',
    'operation_start',
    'operation',
    'compaction_start',
    'compaction',
    'log',
  ].includes(event.type);
}

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

function readEventString(event: FlueEvent, key: string): string | undefined {
  const value = (event as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function readEventNumber(event: FlueEvent, key: string): number | undefined {
  const value = (event as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readEventBoolean(event: FlueEvent, key: string): boolean | undefined {
  const value = (event as Record<string, unknown>)[key];
  return typeof value === 'boolean' ? value : undefined;
}

function trimArray<T>(values: T[], maxLength: number): void {
  if (values.length > maxLength) {
    values.splice(0, values.length - maxLength);
  }
}
