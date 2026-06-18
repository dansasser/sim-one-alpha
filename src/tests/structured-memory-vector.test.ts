import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { LanceDbVectorStore } from '../rag/vector/lance-db-store.js';
import { ChecklistMemoryProvider } from '../memory/checklist-memory-provider.js';
import { InMemoryMemoryEngine } from '../memory/rust-memory-engine.js';
import { StructuredMemoryNoteIndex } from '../memory/structured-memory-note-index.js';
import { ulid } from '../memory/ulid.js';
import type { SessionNote } from '../types/memory.js';

function fakeEmbeddingClient() {
  // Deterministic, network-free embedding: hash the text into a 16-dim vector.
  const embed = (text: string): number[] => {
    const v = new Array(16).fill(0);
    for (let i = 0; i < text.length; i += 1) {
      v[i % 16] = (v[i % 16] + text.charCodeAt(i)) / 1000;
    }
    return v;
  };
  return {
    async embed(text: string): Promise<number[]> { return embed(text); },
    async embedBatch(texts: string[]): Promise<number[][]> {
      return texts.map((t) => embed(t));
    },
    async embedWithOutcome(text: string) {
      return { ok: true as const, result: { vector: embed(text), provider: 'onnx-local' as const, modelId: 'fake' } };
    },
    async embedBatchWithOutcome(texts: string[]) {
      return { ok: true as const, result: { vectors: texts.map((t) => embed(t)), provider: 'onnx-local' as const, modelId: 'fake' } };
    },
  };
}

function makeNote(now: string, content: string, projectId = 'proj-vec'): SessionNote {
  return {
    id: ulid(),
    kind: 'session_note',
    title: 'Decision',
    content,
    scope: { projectId, conversationId: 'conv-vec', actorId: 'actor-vec' },
    tags: [],
    status: 'active',
    importance: 'high',
    createdAt: now,
    updatedAt: now,
    updatedBy: 'orchestrator',
  };
}

test('StructuredMemoryNoteIndex upsert + semantic search returns the note', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gorombo-sm-vector-'));
  const vectorStore = new LanceDbVectorStore({ path: dir });
  const index = new StructuredMemoryNoteIndex({
    vectorStore,
    embeddingClient: fakeEmbeddingClient(),
  });
  try {
    assert.equal(index.available, true);
    const note = makeNote('2026-06-18T00:00:00.000Z', 'use flat store plus tree render');
    await index.upsertNote(note);
    const results = await index.search({
      text: 'flat store tree render',
      scope: { projectId: 'proj-vec' },
      limit: 5,
    });
    assert.ok(results.length > 0, 'vector search returns the note');
    assert.equal(results[0].provider, 'structured-memory');
    assert.equal(results[0].metadata?.kind, 'session_note');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('StructuredMemoryNoteIndex search returns [] when no embedding client is configured (graceful fallback)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gorombo-sm-vector-fb-'));
  const vectorStore = new LanceDbVectorStore({ path: dir });
  const index = new StructuredMemoryNoteIndex({ vectorStore });
  try {
    assert.equal(index.available, false);
    const results = await index.search({ text: 'anything', scope: { projectId: 'p' } });
    assert.deepEqual(results, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('StructuredMemoryNoteIndex delete removes the vector row', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gorombo-sm-vector-del-'));
  const vectorStore = new LanceDbVectorStore({ path: dir });
  const index = new StructuredMemoryNoteIndex({ vectorStore, embeddingClient: fakeEmbeddingClient() });
  try {
    const note = makeNote('2026-06-18T00:00:00.000Z', 'to be deleted');
    await index.upsertNote(note);
    await index.deleteNote(note.id);
    const ids = await vectorStore.listIds('structured_memory_notes');
    assert.ok(!ids.includes(note.id), 'note row deleted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ChecklistMemoryProvider merges keyword + vector results via RRF and falls back when the note index is absent', async () => {
  const engine = new InMemoryMemoryEngine();
  await engine.reconcile({ records: [] });
  // Seed the engine with a note (keyword path) and a checklist.
  const note = await engine.createSessionNote({
    title: 'Decision',
    content: 'flat store plus tree render',
    scope: { projectId: 'proj-merge', conversationId: 'conv-merge', actorId: 'actor-merge' },
    updatedBy: 'orchestrator',
  });
  await engine.createChecklist({
    title: 'Phase merge',
    slug: 'phase-merge',
    scope: { projectId: 'proj-merge', conversationId: 'conv-merge', actorId: 'actor-merge' },
    updatedBy: 'orchestrator',
  });

  // With no note index: keyword-only path still returns records.
  const providerNoVector = new ChecklistMemoryProvider({ engineLoader: () => Promise.resolve(engine) });
  const withoutVector = await providerNoVector.retrieve({
    eventId: 'e',
    text: 'phase',
    actorId: 'actor-merge',
    conversationId: 'conv-merge',
    projectId: 'proj-merge',
  });
  assert.ok(withoutVector.length > 0, 'keyword-only retrieval returns records');
  assert.ok(withoutVector.some((c) => c.metadata?.kind === 'checklist'));

  // With a note index: vector results merge in and do not duplicate keyword hits.
  const dir = mkdtempSync(join(tmpdir(), 'gorombo-sm-vector-merge-'));
  const vectorStore = new LanceDbVectorStore({ path: dir });
  const noteIndex = new StructuredMemoryNoteIndex({ vectorStore, embeddingClient: fakeEmbeddingClient() });
  try {
    await noteIndex.upsertNote(note);
    const providerWithVector = new ChecklistMemoryProvider({
      engineLoader: () => Promise.resolve(engine),
      noteIndex,
    });
    const withVector = await providerWithVector.retrieve({
      eventId: 'e',
      text: 'flat store',
      actorId: 'actor-merge',
      conversationId: 'conv-merge',
      projectId: 'proj-merge',
    });
    // The note should appear (from keyword and/or vector).
    assert.ok(withVector.some((c) => c.metadata?.kind === 'session_note'), 'note present in merged results');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
