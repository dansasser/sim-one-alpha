import assert from 'node:assert/strict';
import test from 'node:test';

import { createInMemoryCodingApprovalService } from '../workers/coding-worker/approvals/approval-service.js';
import { requiresCodingApproval } from '../workers/coding-worker/approvals/approval-policy.js';
import { createCodingTaskMemoryTools } from '../workers/coding-worker/tools/coding-task-memory-tools.js';
import { InMemoryMemoryEngine } from '../memory/rust-memory-engine.js';
import type { MemoryEngine } from '../memory/memory-engine.js';
import type { ToolDefinition } from '@flue/runtime';

function getTool(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return tool;
}

async function setup() {
  const engine = new InMemoryMemoryEngine();
  await engine.reconcile({ records: [] });
  const approvalService = createInMemoryCodingApprovalService();
  const tools = createCodingTaskMemoryTools({
    engineLoader: () => Promise.resolve(engine as MemoryEngine),
    projectId: 'proj-cw',
    approvalService,
  });
  return { engine, approvalService, tools };
}

test('memory.write is NOT a blocking-approval action (audit only)', () => {
  assert.equal(requiresCodingApproval('memory.write'), false);
  assert.equal(requiresCodingApproval('memory.handoff'), false);
  // The blocking set is unchanged for file/shell/git/GitHub.
  assert.equal(requiresCodingApproval('file.edit'), true);
  assert.equal(requiresCodingApproval('git.push'), true);
});

test('coding_task_create_checklist injects projectId from the worker context (model cannot set scope)', async () => {
  const { tools } = await setup();
  const tool = getTool(tools, 'coding_task_create_checklist');
  // Inspect the actual parameter schema keys (not stringified text, which can
  // false-match on description wording) to prove scope/projectId are not exposed.
  const paramKeys = new Set(Object.keys((tool.parameters as { entries?: Record<string, unknown> }).entries ?? {}));
  assert.ok(!paramKeys.has('projectId'), 'projectId must not be a model-facing parameter');
  assert.ok(!paramKeys.has('scope'), 'scope must not be a model-facing parameter');

  const result = JSON.parse(
    await tool.execute({ taskId: 'task-1', title: 'Phase 2', slug: 'phase-2' }),
  ) as { checklist: { scope: { projectId?: string }; id: string } };
  assert.equal(result.checklist.scope.projectId, 'proj-cw');
});

test('coding_task_add_todo records an audit-only memory.write event on the approval service', async () => {
  const { tools, approvalService } = await setup();
  const tool = getTool(tools, 'coding_task_add_todo');
  const created = JSON.parse(
    await tool.execute({ taskId: 'task-audit', title: 'Todo' }),
  ) as { todo: { id: string } };
  const records = await approvalService.listRecords('task-audit');
  const memoryWrite = records.find((r) => r.request.actionType === 'memory.write');
  assert.ok(memoryWrite, 'memory.write audit record exists');
  assert.equal(memoryWrite?.status, 'approved', 'audit record is auto-approved (not pending)');
  assert.equal(memoryWrite?.request.metadata?.agent, 'coding-worker');
  assert.equal(memoryWrite?.request.target, created.todo.id);
});

test('coding_task memory tools require a taskId (trust anchor)', async () => {
  const { tools } = await setup();
  const tool = getTool(tools, 'coding_task_add_todo');
  await assert.rejects(
    tool.execute({ taskId: '', title: 'x' } as never),
    /length|taskId|required schema/i,
  );
});

test('coding_task_search_memory returns RetrievedContext with provider structured-memory', async () => {
  const { tools } = await setup();
  const createTool = getTool(tools, 'coding_task_create_checklist');
  await createTool.execute({ taskId: 'task-s', title: 'Searchable', slug: 'searchable' });
  const searchTool = getTool(tools, 'coding_task_search_memory');
  const result = JSON.parse(
    await searchTool.execute({ taskId: 'task-s', text: 'searchable' }),
  ) as { contexts: { provider: string; metadata: { kind: string } }[] };
  assert.ok(result.contexts.length > 0);
  assert.equal(result.contexts[0].provider, 'structured-memory');
});
