import assert from 'node:assert/strict';
import test from 'node:test';
import { webResearchTool } from '../tools/web-research-tool.js';

test('web_research tool accepts string budget controls and webFetch mode', async () => {
  const result = JSON.parse(
    await webResearchTool.execute({
      eventId: 'event-1',
      text: 'Find the official source.',
      actorId: 'user-1',
      conversationId: 'thread-1',
      maxQueries: '1',
      maxFetches: '1',
      maxContextTokens: '200',
      webFetch: 'never',
      limit: '1',
      freshness: 'fresh',
    }),
  ) as {
    budget?: {
      maxQueries?: number;
      maxFetches?: number;
      maxContextTokens?: number;
    };
    queriesRun?: string[];
  };

  assert.equal(result.budget?.maxQueries, 1);
  assert.equal(result.budget?.maxFetches, 1);
  assert.equal(result.budget?.maxContextTokens, 200);
  assert.deepEqual(result.queriesRun, ['Find the official source.']);
});
