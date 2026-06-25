import assert from 'node:assert/strict';
import test from 'node:test';
import { webResearchTool } from '../engine/tools/web-research-tool.js';
import { goromboPersistenceRuntime } from '../db.js';

function seedEvent() {
  const db = goromboPersistenceRuntime.sessionDatabase;
  const id = `event-web-research-${Date.now()}`;
  db.recordNormalizedMessageEvent({
    event: {
      id,
      connector: 'test',
      kind: 'chat.message',
      text: 'seed event',
      receivedAt: new Date().toISOString(),
      actor: { id: 'user-1' },
      conversation: { id: 'thread-1' },
    },
  });
  return { id };
}

test('web_research tool accepts string budget controls and webFetch mode', async () => {
  const seeded = seedEvent();
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              title: 'Official source',
              url: 'https://example.com/source',
              content: 'This is the official source.',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );

    const result = JSON.parse(
      await webResearchTool.execute({
        eventId: seeded.id,
        text: 'Find the official source.',
        depth: 'basic',
        maxQueries: '1',
        maxFetches: '1',
        maxContextTokens: '200',
        webFetch: 'never',
        limit: '1',
        freshness: 'fresh',
        minSources: '1',
        maxIterations: '1',
      }),
    ) as {
      budget?: {
        depth?: string;
        maxQueries?: number;
        maxFetches?: number;
        maxContextTokens?: number;
        minSources?: number;
        maxIterations?: number;
      };
      queriesRun?: string[];
    };

    assert.equal(result.budget?.depth, 'basic');
    assert.equal(result.budget?.maxQueries, 1);
    assert.equal(result.budget?.maxFetches, 1);
    assert.equal(result.budget?.maxContextTokens, 200);
    assert.equal(result.budget?.minSources, 1);
    assert.equal(result.budget?.maxIterations, 1);
    assert.deepEqual(result.queriesRun, ['Find the official source.']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('web_research tool falls back to explicit actor/conversation when event is not persisted', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              title: 'Test source',
              url: 'https://example.com/test',
              content: 'Test content.',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );

    const result = JSON.parse(
      await webResearchTool.execute({
        eventId: 'nonexistent-event-id',
        text: 'query',
        actorId: 'tui-user',
        conversationId: 'tui-conversation',
        depth: 'basic',
        maxQueries: '1',
        maxFetches: '1',
        maxContextTokens: '200',
        webFetch: 'never',
        limit: '1',
        freshness: 'fresh',
        minSources: '1',
        maxIterations: '1',
      }),
    ) as { budget?: { depth?: string } };

    assert.equal(result.budget?.depth, 'basic');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
