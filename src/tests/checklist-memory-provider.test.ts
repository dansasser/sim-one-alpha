import assert from 'node:assert/strict';
import test from 'node:test';

import { ChecklistMemoryProvider, toRetrievedContext } from '../memory/checklist-memory-provider.js';
import { InMemoryMemoryEngine } from '../memory/rust-memory-engine.js';
import { ulid } from '../memory/ulid.js';
import type { RagQuery } from '../types/index.js';
import type { Checklist, SessionNote, Todo } from '../types/memory.js';

function baseQuery(overrides: Partial<RagQuery> = {}): RagQuery {
  return {
    eventId: 'evt-1',
    text: 'phase',
    actorId: 'actor-1',
    conversationId: 'conv-1',
    projectId: 'proj-1',
    ...overrides,
  };
}

async function seedEngine() {
  const engine = new InMemoryMemoryEngine();
  await engine.reconcile({ records: [] });
  const checklist = await engine.createChecklist({
    title: 'Phase 0 prep',
    slug: 'phase-0-prep',
    scope: { projectId: 'proj-1', conversationId: 'conv-1', actorId: 'actor-1' },
    items: [{ title: 'Schemas' }, { title: 'Engine' }],
    updatedBy: 'orchestrator',
  });
  const todo = await engine.createTodo({
    title: 'Run phase smoke',
    scope: { projectId: 'proj-1', conversationId: 'conv-1', actorId: 'actor-1' },
    updatedBy: 'orchestrator',
  });
  const note = await engine.createSessionNote({
    title: 'Phase decision',
    content: 'flat store plus tree render',
    scope: { projectId: 'proj-1', conversationId: 'conv-1', actorId: 'actor-1' },
    updatedBy: 'orchestrator',
  });
  return { engine, checklist, todo, note };
}

test('ChecklistMemoryProvider.retrieve returns structured records as RetrievedContext with provider structured-memory', async () => {
  const { engine } = await seedEngine();
  const provider = new ChecklistMemoryProvider({ engineLoader: () => Promise.resolve(engine) });
  const contexts = await provider.retrieve(baseQuery({ text: 'phase' }));
  assert.ok(contexts.length > 0, 'expected matches for "phase"');
  for (const context of contexts) {
    assert.equal(context.provider, 'structured-memory');
    assert.ok(['checklist', 'todo', 'session_note'].includes(context.metadata?.kind as string));
    assert.ok(context.id.startsWith('structured-memory:'));
  }
});

test('ChecklistMemoryProvider.retrieve isolates by project scope', async () => {
  const { engine } = await seedEngine();
  const provider = new ChecklistMemoryProvider({ engineLoader: () => Promise.resolve(engine) });
  const otherProject = await provider.retrieve(baseQuery({ text: 'phase', projectId: 'proj-other' }));
  assert.equal(otherProject.length, 0, 'cross-project query must not leak records');
  const ownProject = await provider.retrieve(baseQuery({ text: 'phase', projectId: 'proj-1' }));
  assert.ok(ownProject.length > 0, 'same-project query returns records');
});

test('ChecklistMemoryProvider.retrieve truncates to the token budget', async () => {
  const { engine } = await seedEngine();
  const provider = new ChecklistMemoryProvider({
    engineLoader: () => Promise.resolve(engine),
    maxContextTokens: 1,
  });
  const contexts = await provider.retrieve(baseQuery({ text: 'phase' }));
  // With a 1-token budget, at most one record fits (the first non-empty wins;
  // subsequent records are skipped once the budget is exceeded).
  assert.ok(contexts.length <= 1, 'token budget truncates the result list');
});

test('ChecklistMemoryProvider.retrieve returns [] for empty query text', async () => {
  const { engine } = await seedEngine();
  const provider = new ChecklistMemoryProvider({ engineLoader: () => Promise.resolve(engine) });
  const contexts = await provider.retrieve(baseQuery({ text: '   ' }));
  assert.deepEqual(contexts, []);
});

test('toRetrievedContext stamps kind, scope, and tokenEstimate metadata', () => {
  const checklist: Checklist = {
    id: ulid(),
    kind: 'checklist',
    title: 'T',
    slug: 't',
    scope: { projectId: 'p' },
    tags: [],
    status: 'active',
    items: [],
    createdAt: '2026-06-18T00:00:00.000Z',
    updatedAt: '2026-06-18T00:00:00.000Z',
    updatedBy: 'orch',
  };
  const ctx = toRetrievedContext(checklist);
  assert.equal(ctx.metadata?.kind, 'checklist');
  assert.equal(typeof ctx.metadata?.tokenEstimate, 'number');
  assert.deepEqual(ctx.metadata?.scope, { projectId: 'p' });
});
