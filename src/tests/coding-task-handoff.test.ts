import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createInMemoryCodingApprovalService } from '../engine/workers/coding-worker/approvals/approval-service.js';
import { createCodingTaskMemoryTools } from '../engine/workers/coding-worker/tools/coding-task-memory-tools.js';
import { InMemoryCodingTaskRunStore } from '../engine/workers/coding-worker/session/task-run-store.js';
import { InMemoryMemoryEngine } from '../engine/memory/rust-memory-engine.js';
import type { CodingTaskRunRecord } from '../engine/workers/coding-worker/session/task-run-store.js';
import type { ToolDefinition } from '@flue/runtime';

function getTool(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return tool;
}

test('coding_task_handoff_plan_to_checklist copies a task run plan into a durable checklist', async () => {
  const engine = new InMemoryMemoryEngine();
  await engine.reconcile({ records: [] });
  const approvalService = createInMemoryCodingApprovalService();
  const taskRunStore = new InMemoryCodingTaskRunStore();

  const run: CodingTaskRunRecord = {
    taskId: 'src-task-1',
    status: 'completed',
    sessionPlan: { harness: 'coding-worker', session: 'src-task-1' } as never,
    plan: [
      { id: 'p1', description: 'Scaffold crate', owner: 'implementer', status: 'completed' },
      { id: 'p2', description: 'Write tests', owner: 'test-debug', status: 'in_progress' },
      { id: 'p3', description: 'Review', owner: 'code-review', status: 'blocked' },
    ],
    events: [],
    verificationEvidence: [],
    createdAt: '2026-06-18T00:00:00.000Z',
    updatedAt: '2026-06-18T00:00:00.000Z',
  };
  await taskRunStore.upsert(run);

  const tools = createCodingTaskMemoryTools({
    engineLoader: () => Promise.resolve(engine),
    projectId: 'proj-handoff',
    approvalService,
    taskRunStore,
  });

  const handoff = getTool(tools, 'coding_task_handoff_plan_to_checklist');
  const result = JSON.parse(
    await handoff.execute({ taskId: 'task-handoff', sourceTaskId: 'src-task-1' }),
  ) as { checklist: { id: string; title: string; items: { title: string; status: string; tags: string[] }[] } };

  assert.equal(result.checklist.title, 'Handoff: src-task-1');
  assert.equal(result.checklist.items.length, 3);
  assert.equal(result.checklist.items[0].title, 'Scaffold crate');
  assert.equal(result.checklist.items[0].status, 'completed');
  assert.equal(result.checklist.items[1].status, 'in_progress');
  assert.equal(result.checklist.items[2].status, 'blocked');

  // The new checklist is retrievable via the engine query.
  const records = await engine.query({ scope: { projectId: 'proj-handoff' }, text: 'handoff' });
  assert.ok(records.some((r) => r.kind === 'checklist' && r.id === result.checklist.id));

  // A memory.handoff audit event was recorded.
  const audit = await approvalService.listRecords('task-handoff');
  assert.ok(audit.some((r) => r.request.actionType === 'memory.handoff' && r.status === 'approved'));
});

test('coding_task_handoff_plan_to_checklist rejects an unknown source task', async () => {
  const engine = new InMemoryMemoryEngine();
  await engine.reconcile({ records: [] });
  const dir = mkdtempSync(join(tmpdir(), 'handoff-'));
  try {
    const tools = createCodingTaskMemoryTools({
      engineLoader: () => Promise.resolve(engine),
      projectId: 'proj-handoff2',
      approvalService: createInMemoryCodingApprovalService(),
      workspaceRoot: dir,
    });
    const handoff = getTool(tools, 'coding_task_handoff_plan_to_checklist');
    await assert.rejects(
      handoff.execute({ taskId: 't', sourceTaskId: 'no-such-task' }),
      /not found/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
