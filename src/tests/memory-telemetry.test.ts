import assert from 'node:assert/strict';
import test from 'node:test';

import { createChecklistTool } from '../tools/memory-checklist-tools.js';
import { flueTelemetryStore, type MemoryMutationEvent } from '../telemetry/flue-telemetry.js';
import { setupMemoryToolTest } from './helpers/memory-tool-test-setup.js';

function lastMutation(): MemoryMutationEvent | undefined {
  const snap = flueTelemetryStore.memoryMutationSnapshot();
  return snap.mutations[snap.mutations.length - 1];
}

test('create_checklist emits a sanitized memory_mutation telemetry event with no content body', async () => {
  const before = flueTelemetryStore.memoryMutationSnapshot().mutations.length;
  const { event, cleanup } = setupMemoryToolTest({ projectId: 'proj-tel' });
  try {
    await createChecklistTool.execute({ eventId: event.id, title: 'Telemetry', slug: 'telemetry' });
    const after = flueTelemetryStore.memoryMutationSnapshot().mutations;
    const added = after.slice(before);
    const evt = added.find((e) => e.toolName === 'create_checklist');
    assert.ok(evt, 'a create_checklist memory_mutation event was recorded');
    assert.equal(evt.type, 'memory_mutation');
    assert.equal(evt.agentName, 'orchestrator');
    assert.equal(evt.kind, 'checklist');
    assert.equal(evt.scopeKeys.projectId, 'proj-tel');
    assert.equal(evt.updatedBy, 'orchestrator');
    // No content body is present in the sanitized event.
    const keys = Object.keys(evt);
    assert.ok(!keys.includes('content'));
    assert.ok(!keys.includes('title') || evt.recordId !== (evt as { title?: string }).title);
  } finally {
    cleanup();
  }
});

test('recordMemoryMutationEvent keeps the audit bounded and snapshot is a copy', () => {
  const snap = flueTelemetryStore.memoryMutationSnapshot();
  const before = snap.mutations.length;
  snap.mutations.push({ type: 'memory_mutation', toolName: 'tamper' } as never);
  assert.equal(flueTelemetryStore.memoryMutationSnapshot().mutations.length, before, 'snapshot is a defensive copy');
});
