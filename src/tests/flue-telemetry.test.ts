import assert from 'node:assert/strict';
import test from 'node:test';
import type { FlueEvent } from '@flue/runtime';
import {
  FlueTelemetryStore,
  summarizeTelemetryRunFromEvents,
} from '../telemetry/flue-telemetry.js';

test('telemetry store summarizes researcher delegation and web research calls', () => {
  const store = new FlueTelemetryStore();

  store.record(createEvent({ type: 'run_start', runId: 'agent:orchestrator:run-1' }));
  store.record(
    createEvent({
      type: 'task_start',
      runId: 'agent:orchestrator:run-1',
      taskId: 'task-1',
      agent: 'researcher',
      session: 'support',
    }),
  );
  store.record(
    createEvent({
      type: 'tool_start',
      runId: 'agent:orchestrator:run-1',
      taskId: 'task-1',
      toolCallId: 'tool-1',
      toolName: 'web_research',
    }),
  );
  store.record(
    createEvent({
      type: 'operation',
      runId: 'agent:orchestrator:run-1',
      operationId: 'operation-1',
      operationKind: 'task',
      durationMs: 123,
      isError: false,
      usage: {
        input: 1,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 3,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
    }),
  );

  const summary = store.getRunSummary('agent:orchestrator:run-1');

  assert.equal(summary?.delegatedToResearcher, true);
  assert.equal(summary?.calledWebResearch, true);
  assert.equal(summary?.taskStarts[0]?.agent, 'researcher');
  assert.equal(summary?.toolCalls[0]?.toolName, 'web_research');
  assert.equal(summary?.operations[0]?.usage?.totalTokens, 3);
  assert.equal(summary?.events.some((event) => 'prompt' in event), false);
});

test('telemetry store keeps unrelated runs separate', () => {
  const store = new FlueTelemetryStore();

  store.record(createEvent({ type: 'task_start', runId: 'agent:orchestrator:run-1', taskId: 'task-1', agent: 'researcher' }));
  store.record(createEvent({ type: 'task_start', runId: 'agent:orchestrator:run-2', taskId: 'task-2', agent: 'coding-worker' }));

  assert.equal(store.getRunSummary('agent:orchestrator:run-1')?.delegatedToResearcher, true);
  assert.equal(store.getRunSummary('agent:orchestrator:run-2')?.delegatedToResearcher, false);
});

test('telemetry store trims oldest runs through serialized mutations', () => {
  const store = new FlueTelemetryStore({ maxRuns: 1 });

  store.record(createEvent({ type: 'run_start', runId: 'agent:orchestrator:run-1' }));
  store.record(createEvent({ type: 'run_start', runId: 'agent:orchestrator:run-2' }));

  const snapshot = store.snapshot();

  assert.equal(snapshot.runs.length, 1);
  assert.equal(snapshot.runs[0]?.runId, 'agent:orchestrator:run-2');
  assert.equal(store.getRunSummary('agent:orchestrator:run-1'), undefined);
});

test('telemetry summary can be rebuilt from persisted Flue run events', () => {
  const summary = summarizeTelemetryRunFromEvents('agent:orchestrator:run-persisted', [
    {
      type: 'run_start',
      runId: 'agent:orchestrator:run-persisted',
      payload: {
        text: 'do not expose this prompt text',
      },
      timestamp: '2026-06-10T00:00:00.000Z',
    },
    {
      type: 'operation',
      runId: 'agent:orchestrator:run-persisted',
      operationId: 'operation-1',
      operationKind: 'prompt',
      isError: false,
      durationMs: 42,
      result: {
        text: 'do not expose this result text',
      },
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
      },
    },
    {
      type: 'run_end',
      runId: 'agent:orchestrator:run-persisted',
      result: {
        text: 'do not expose final result text',
      },
      isError: false,
      durationMs: 43,
    },
  ]);

  assert.equal(summary?.eventCount, 3);
  assert.equal(summary?.operations[0]?.usage?.totalTokens, 15);
  assert.equal(summary?.events.some((event) => 'payload' in event), false);
  assert.equal(summary?.events.some((event) => 'result' in event), false);
});

test('telemetry summary ignores invalid persisted run event entries', () => {
  const summary = summarizeTelemetryRunFromEvents('agent:orchestrator:run-invalid', [
    null,
    'bad event',
    {
      payload: 'missing type',
    },
    {
      type: 'tool_call',
      runId: 'agent:orchestrator:run-invalid',
      toolName: 'web_research',
    },
  ]);

  assert.equal(summary?.eventCount, 1);
  assert.equal(summary?.calledWebResearch, true);
});

function createEvent(input: Record<string, unknown>): FlueEvent {
  return input as unknown as FlueEvent;
}
