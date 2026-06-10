import assert from 'node:assert/strict';
import test from 'node:test';
import type { FlueEvent } from '@flue/runtime';
import { FlueTelemetryStore } from '../telemetry/flue-telemetry.js';

test('telemetry store summarizes researcher delegation and web research calls', () => {
  const store = new FlueTelemetryStore();

  store.record(createEvent({ type: 'run_start', runId: 'workflow:chat:run-1' }));
  store.record(
    createEvent({
      type: 'task_start',
      runId: 'workflow:chat:run-1',
      taskId: 'task-1',
      agent: 'researcher',
      session: 'support',
    }),
  );
  store.record(
    createEvent({
      type: 'tool_start',
      runId: 'workflow:chat:run-1',
      taskId: 'task-1',
      toolCallId: 'tool-1',
      toolName: 'web_research',
    }),
  );
  store.record(
    createEvent({
      type: 'operation',
      runId: 'workflow:chat:run-1',
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

  const summary = store.getRunSummary('workflow:chat:run-1');

  assert.equal(summary?.delegatedToResearcher, true);
  assert.equal(summary?.calledWebResearch, true);
  assert.equal(summary?.taskStarts[0]?.agent, 'researcher');
  assert.equal(summary?.toolCalls[0]?.toolName, 'web_research');
  assert.equal(summary?.operations[0]?.usage?.totalTokens, 3);
  assert.equal(summary?.events.some((event) => 'prompt' in event), false);
});

test('telemetry store keeps unrelated runs separate', () => {
  const store = new FlueTelemetryStore();

  store.record(createEvent({ type: 'task_start', runId: 'workflow:chat:run-1', taskId: 'task-1', agent: 'researcher' }));
  store.record(createEvent({ type: 'task_start', runId: 'workflow:chat:run-2', taskId: 'task-2', agent: 'coding-worker' }));

  assert.equal(store.getRunSummary('workflow:chat:run-1')?.delegatedToResearcher, true);
  assert.equal(store.getRunSummary('workflow:chat:run-2')?.delegatedToResearcher, false);
});

test('telemetry store trims oldest runs through serialized mutations', () => {
  const store = new FlueTelemetryStore({ maxRuns: 1 });

  store.record(createEvent({ type: 'run_start', runId: 'workflow:chat:run-1' }));
  store.record(createEvent({ type: 'run_start', runId: 'workflow:chat:run-2' }));

  const snapshot = store.snapshot();

  assert.equal(snapshot.runs.length, 1);
  assert.equal(snapshot.runs[0]?.runId, 'workflow:chat:run-2');
  assert.equal(store.getRunSummary('workflow:chat:run-1'), undefined);
});

function createEvent(input: Record<string, unknown>): FlueEvent {
  return input as unknown as FlueEvent;
}
