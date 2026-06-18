import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryRouter, reciprocalRankFusion } from '../memory/memory-router.js';
import type { MemoryProvider } from '../memory/memory-provider.js';
import type { RagQuery, RetrievedContext } from '../types/index.js';

function ctx(id: string, score: number, provider: RetrievedContext['provider'], title = id): RetrievedContext {
  return { id, provider, title, content: `c-${id}`, score };
}

function provider(list: RetrievedContext[]): MemoryProvider {
  return {
    async retrieve(_query: RagQuery): Promise<RetrievedContext[]> {
      return list;
    },
  };
}

test('MemoryRouter fans out to enabled providers and merges with RRF', async () => {
  const providers = new Map([
    ['memory', provider([ctx('a', 0.9, 'memory'), ctx('b', 0.8, 'memory')])],
    ['structured-memory', provider([ctx('b', 0.95, 'structured-memory'), ctx('c', 0.7, 'structured-memory')])],
  ] as Array<[RetrievedContext['provider'], MemoryProvider]>);
  const router = new MemoryRouter(providers);
  const result = await router.retrieve({
    eventId: 'e',
    text: 'q',
    actorId: 'a',
    conversationId: 'c',
    providers: ['memory', 'structured-memory'],
  });
  // All four contexts are present (cross-provider records are distinct, so
  // the two 'b' entries from different providers are NOT merged).
  assert.equal(result.length, 4);
  assert.ok(result.some((r) => r.id === 'a'));
  assert.ok(result.some((r) => r.id === 'b' && r.provider === 'memory'));
  assert.ok(result.some((r) => r.id === 'b' && r.provider === 'structured-memory'));
  assert.ok(result.some((r) => r.id === 'c'));
});

test('MemoryRouter.fromSingle registers one provider under a kind', async () => {
  const router = MemoryRouter.fromSingle('memory', provider([ctx('only', 1, 'memory')]));
  const result = await router.retrieve({ eventId: 'e', text: 'q', actorId: 'a', conversationId: 'c' });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'only');
});

test('reciprocalRankFusion merges and de-duplicates by provider+id', () => {
  const merged = reciprocalRankFusion([
    [ctx('a', 1, 'memory'), ctx('b', 1, 'memory')],
    [ctx('b', 1, 'structured-memory')],
  ]);
  // 'b' from different providers are distinct (different provider key).
  assert.equal(merged.length, 3);
  // 'b' from memory and 'b' from structured-memory both present.
  assert.equal(merged.filter((m) => m.id === 'b').length, 2);
});

test('MemoryRouter swallows a failing provider and continues', async () => {
  const failing: MemoryProvider = {
    async retrieve(): Promise<RetrievedContext[]> {
      throw new Error('boom');
    },
  };
  const providers = new Map([
    ['memory', failing],
    ['structured-memory', provider([ctx('ok', 1, 'structured-memory')])],
  ] as Array<[RetrievedContext['provider'], MemoryProvider]>);
  const router = new MemoryRouter(providers);
  const result = await router.retrieve({
    eventId: 'e',
    text: 'q',
    actorId: 'a',
    conversationId: 'c',
    providers: ['memory', 'structured-memory'],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'ok');
});
