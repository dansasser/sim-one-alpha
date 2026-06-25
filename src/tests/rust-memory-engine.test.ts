import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type { MemoryEngine } from '../engine/memory/memory-engine.js';
import { InMemoryMemoryEngine, RustMemoryEngine } from '../engine/memory/rust-memory-engine.js';
import { ulid } from '../engine/memory/ulid.js';

const WASM_MODULE_PATH = path.resolve(
  process.cwd(),
  'crates',
  'gorombo-memory',
  'pkg',
  'gorombo_memory.js',
);
const WASM_AVAILABLE = existsSync(WASM_MODULE_PATH);

const SCOPE = { projectId: 'proj-parity' };
const OTHER_SCOPE = { projectId: 'proj-other' };
const AUDIT = { updatedBy: 'orchestrator', runId: 'run-1' };

/** A scripted sequence run against any MemoryEngine. Returns collected facts. */
async function script(engine: MemoryEngine) {
  await engine.reconcile({ records: [] });

  const checklist = await engine.createChecklist({
    title: 'Smoke checklist',
    slug: 'smoke',
    scope: SCOPE,
    items: [{ title: 'first' }, { title: 'second' }],
    ...AUDIT,
  });

  const firstItemId = checklist.items[0]?.id;
  assert.ok(firstItemId, 'first item id assigned');
  const withChild = await engine.addChecklistItem({
    checklistId: checklist.id,
    parentId: firstItemId,
    title: 'child',
    ...AUDIT,
  });

  const todo = await engine.createTodo({
    title: 'Run smoke',
    scope: SCOPE,
    priority: 'high',
    ...AUDIT,
  });

  const note = await engine.createSessionNote({
    title: 'Decision',
    content: 'flat store + tree render',
    scope: SCOPE,
    importance: 'high',
    ...AUDIT,
  });

  const querySmoke = await engine.query({ scope: SCOPE, text: 'smoke' });
  const queryOtherScope = await engine.query({ scope: OTHER_SCOPE, text: 'smoke' });
  const queryTodos = await engine.query({ scope: SCOPE, kinds: ['todo'] });

  await engine.delete({ id: todo.id, ...AUDIT });
  const queryTodosAfterDelete = await engine.query({ scope: SCOPE, kinds: ['todo'] });

  return {
    checklistKind: checklist.kind,
    checklistStatus: checklist.status,
    checklistItems: checklist.items.length,
    itemStatuses: checklist.items.map((i) => i.status),
    withChildItems: withChild.items.length,
    childLinksToFirst: withChild.items.find((i) => i.title === 'child')?.parentId === firstItemId,
    todoKind: todo.kind,
    noteKind: note.kind,
    noteImportance: note.importance,
    querySmokeKinds: querySmoke.map((r) => r.kind).sort(),
    queryOtherScopeCount: queryOtherScope.length,
    queryTodosCount: queryTodos.length,
    queryTodosAfterDeleteCount: queryTodosAfterDelete.length,
  };
}

test('InMemoryMemoryEngine runs the scripted sequence and produces expected facts', async () => {
  const facts = await script(new InMemoryMemoryEngine());
  assert.equal(facts.checklistKind, 'checklist');
  assert.equal(facts.checklistStatus, 'active');
  assert.equal(facts.checklistItems, 2);
  assert.deepEqual(facts.itemStatuses, ['pending', 'pending']);
  assert.equal(facts.withChildItems, 3);
  assert.equal(facts.childLinksToFirst, true);
  assert.equal(facts.todoKind, 'todo');
  assert.equal(facts.noteKind, 'session_note');
  assert.equal(facts.noteImportance, 'high');
  assert.deepEqual(facts.querySmokeKinds, ['checklist', 'todo']);
  assert.equal(facts.queryOtherScopeCount, 0);
  assert.equal(facts.queryTodosCount, 1);
  assert.equal(facts.queryTodosAfterDeleteCount, 0);
});

test('RustMemoryEngine + InMemoryMemoryEngine agree on the scripted sequence (parity)', async () => {
  if (!WASM_AVAILABLE) {
    test.skip('gorombo-memory WASM artifact not built; run `wasm-pack build crates/gorombo-memory --target nodejs --out-dir pkg`');
    return;
  }
  const wasm = await RustMemoryEngine.load({ wasmModulePath: WASM_MODULE_PATH, expectedVersion: '0.1.0' });
  const [wasmFacts, memFacts] = await Promise.all([script(wasm), script(new InMemoryMemoryEngine())]);
  assert.deepEqual(wasmFacts, memFacts);
});

test('RustMemoryEngine asserts the WASM version on load', async () => {
  if (!WASM_AVAILABLE) {
    test.skip('gorombo-memory WASM artifact not built');
    return;
  }
  await assert.rejects(
    RustMemoryEngine.load({ wasmModulePath: WASM_MODULE_PATH, expectedVersion: '9.9.9' }),
    /version mismatch/i,
  );
});

test('both engines reject an empty scope on create', async () => {
  const engines: MemoryEngine[] = [new InMemoryMemoryEngine()];
  if (WASM_AVAILABLE) {
    engines.push(await RustMemoryEngine.load({ wasmModulePath: WASM_MODULE_PATH, expectedVersion: '0.1.0' }));
  }
  for (const engine of engines) {
    await engine.reconcile({ records: [] });
    await assert.rejects(
      engine.createChecklist({ title: 't', slug: 's', scope: {}, ...AUDIT }),
      /scope|validation/i,
    );
  }
});

test('both engines enforce slug uniqueness within a scope', async () => {
  const engines: MemoryEngine[] = [new InMemoryMemoryEngine()];
  if (WASM_AVAILABLE) {
    engines.push(await RustMemoryEngine.load({ wasmModulePath: WASM_MODULE_PATH, expectedVersion: '0.1.0' }));
  }
  for (const engine of engines) {
    await engine.reconcile({ records: [] });
    await engine.createChecklist({ title: 'a', slug: 'dup', scope: SCOPE, ...AUDIT });
    await assert.rejects(
      engine.createChecklist({ title: 'b', slug: 'dup', scope: SCOPE, ...AUDIT }),
      /already exists/i,
    );
  }
});

test('ulid() produces 26-char Crockford base32', () => {
  const id = ulid();
  assert.equal(id.length, 26);
  assert.match(id, /^[0-9A-HJ-NP-TV-Z]{26}$/);
});
