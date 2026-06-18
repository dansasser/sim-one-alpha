import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  getStructuredMemoryRuntime,
  resetStructuredMemoryRuntime,
  type GoromboMemoryConfig,
} from '../memory/structured-memory-runtime.js';
import type { GoromboConfig } from '../config/gorombo-config.js';

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gorombo-rt-'));
  return join(dir, 'structured.sqlite');
}

function configWith(sqlitePath: string, memory: Partial<GoromboMemoryConfig> = {}): GoromboConfig {
  return {
    version: 1,
    models: { primary: 'x' },
    memory: { backend: 'memory', sqlitePath, ...memory },
  } as unknown as GoromboConfig;
}

test('structured-memory runtime persists records across a simulated restart', async () => {
  const sqlitePath = tmpDbPath();
  try {
    resetStructuredMemoryRuntime();
    const first = await getStructuredMemoryRuntime(configWith(sqlitePath));
    const checklist = await first.engine.createChecklist({
      title: 'Durable checklist',
      slug: 'durable',
      scope: { projectId: 'proj-rt', conversationId: 'conv-rt' },
      items: [{ title: 'One' }, { title: 'Two' }],
      updatedBy: 'orchestrator',
    });
    await first.engine.createTodo({
      title: 'Durable todo',
      scope: { projectId: 'proj-rt', conversationId: 'conv-rt' },
      updatedBy: 'orchestrator',
    });
    assert.ok(checklist.id);

    // Simulate a process restart: drop the singleton, re-create from the same
    // SQLite file. The new engine re-hydrates from the durable store.
    resetStructuredMemoryRuntime();
    const second = await getStructuredMemoryRuntime(configWith(sqlitePath));
    const records = await second.engine.query({
      scope: { projectId: 'proj-rt', conversationId: 'conv-rt' },
      text: 'durable',
    });
    assert.ok(records.some((r) => r.kind === 'checklist' && r.title === 'Durable checklist'));
    assert.ok(records.some((r) => r.kind === 'todo' && r.title === 'Durable todo'));
  } finally {
    resetStructuredMemoryRuntime();
    rmSync(join(sqlitePath, '..'), { recursive: true, force: true });
  }
});

test('structured-memory runtime exposes the structured-memory provider', async () => {
  const sqlitePath = tmpDbPath();
  try {
    resetStructuredMemoryRuntime();
    const runtime = await getStructuredMemoryRuntime(configWith(sqlitePath));
    assert.equal(typeof runtime.provider.retrieve, 'function');
    // provider.retrieve against an empty store returns [].
    const contexts = await runtime.provider.retrieve({
      eventId: 'e',
      text: 'nothing-here',
      actorId: 'a',
      conversationId: 'c',
      projectId: 'proj-rt',
    });
    assert.deepEqual(contexts, []);
  } finally {
    resetStructuredMemoryRuntime();
    rmSync(join(sqlitePath, '..'), { recursive: true, force: true });
  }
});
