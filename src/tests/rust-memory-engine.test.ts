import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  InMemoryMemoryEngine,
  MemoryEngineError,
  MemoryEngineErrorKind,
  RustMemoryEngine,
} from '../memory/rust-memory-engine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmPath = resolve(__dirname, '../../../crates/gorombo-memory/pkg/gorombo_memory.js');

async function makeWASMEngine(): Promise<RustMemoryEngine> {
  return RustMemoryEngine.load({ wasmPath, expectedVersion: '0.1.0' });
}

function makeInMemoryEngine(): InMemoryMemoryEngine {
  return new InMemoryMemoryEngine();
}

const baseChecklistInput = {
  title: 'Phase 0 prep',
  slug: 'phase-0-prep',
  scope: { projectId: 'gorombo' },
  items: [{ title: 'Define schemas' }, { title: 'Write types' }],
  audit: { updatedBy: 'test' },
};

const baseTodoInput = {
  title: 'Run smoke test',
  scope: { projectId: 'gorombo' },
  audit: { updatedBy: 'test' },
};

const baseNoteInput = {
  title: 'Architecture decision',
  content: 'Use Rust/WASM for the memory engine.',
  scope: { projectId: 'gorombo' },
  audit: { updatedBy: 'test' },
};

describe('RustMemoryEngine', () => {
  it('loads and validates version', async () => {
    const engine = await makeWASMEngine();
    assert.strictEqual(await engine.version(), '0.1.0');
  });

  it('rejects a mismatched expected version', async () => {
    await assert.rejects(
      () => RustMemoryEngine.load({ wasmPath, expectedVersion: '99.99.99' }),
      (err: unknown) => {
        assert.ok(err instanceof MemoryEngineError);
        assert.strictEqual((err as MemoryEngineError).kind, MemoryEngineErrorKind.Internal);
        return true;
      },
    );
  });

  it('runs a full CRUD flow', async () => {
    const engine = await makeWASMEngine();
    await engine.reconcile({ records: [] });

    const checklist = await engine.createChecklist(baseChecklistInput);
    assert.strictEqual(checklist.kind, 'checklist');
    assert.strictEqual(checklist.title, 'Phase 0 prep');
    assert.strictEqual(checklist.items.length, 2);

    const todo = await engine.createTodo(baseTodoInput);
    assert.strictEqual(todo.kind, 'todo');
    assert.strictEqual(todo.title, 'Run smoke test');

    const note = await engine.createSessionNote(baseNoteInput);
    assert.strictEqual(note.kind, 'session_note');
    assert.strictEqual(note.title, 'Architecture decision');

    const result = await engine.query({ text: 'smoke', scope: { projectId: 'gorombo' } });
    assert.ok(result.records.some((r) => r.kind === 'todo' && r.title === 'Run smoke test'));

    const crossProject = await engine.query({ text: 'smoke', scope: { projectId: 'other' } });
    assert.strictEqual(crossProject.records.length, 0);

    await engine.delete({ id: todo.id, kind: 'todo', scope: { projectId: 'gorombo' }, audit: { updatedBy: 'test' } });
    const afterDelete = await engine.query({ text: 'smoke', scope: { projectId: 'gorombo' } });
    assert.strictEqual(afterDelete.records.length, 0);
  });
});

describe('InMemoryMemoryEngine parity', () => {
  it('produces matching records for create operations', async () => {
    const wasm = await makeWASMEngine();
    const mem = makeInMemoryEngine();

    await wasm.reconcile({ records: [] });
    await mem.reconcile({ records: [] });

    const wasmChecklist = await wasm.createChecklist(baseChecklistInput);
    const memChecklist = await mem.createChecklist(baseChecklistInput);

    assert.strictEqual(wasmChecklist.title, memChecklist.title);
    assert.strictEqual(wasmChecklist.slug, memChecklist.slug);
    assert.strictEqual(wasmChecklist.items.length, memChecklist.items.length);
    assert.strictEqual(wasmChecklist.items[0].title, memChecklist.items[0].title);

    const wasmTodo = await wasm.createTodo(baseTodoInput);
    const memTodo = await mem.createTodo(baseTodoInput);
    assert.strictEqual(wasmTodo.title, memTodo.title);
    assert.strictEqual(wasmTodo.status, memTodo.status);

    const wasmNote = await wasm.createSessionNote(baseNoteInput);
    const memNote = await mem.createSessionNote(baseNoteInput);
    assert.strictEqual(wasmNote.title, memNote.title);
    assert.strictEqual(wasmNote.content, memNote.content);

    const wasmQuery = await wasm.query({ text: 'Phase 0 prep', scope: { projectId: 'gorombo' } });
    const memQuery = await mem.query({ text: 'Phase 0 prep', scope: { projectId: 'gorombo' } });
    assert.ok(
      wasmQuery.records.some((r) => r.title === 'Phase 0 prep'),
      'WASM query should find checklist by title',
    );
    assert.ok(
      memQuery.records.some((r) => r.title === 'Phase 0 prep'),
      'In-memory query should find checklist by title',
    );
  });
});
