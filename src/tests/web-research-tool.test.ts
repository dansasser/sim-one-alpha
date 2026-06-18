import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webResearchTool } from '../tools/web-research-tool.js';
import { GoromboSessionDatabase } from '../session/session-database.js';

function seedEvent() {
  const dir = mkdtempSync(join(tmpdir(), 'web-research-test-'));
  const db = new GoromboSessionDatabase(join(dir, 'sessions.sqlite'));
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
  db.close();
  return { id, dir };
}

test('web_research tool accepts string budget controls and webFetch mode', async () => {
  const seeded = seedEvent();
  try {
    const result = JSON.parse(
      await webResearchTool.execute({
        eventId: seeded.id,
        text: 'Find the official source.',
        actorId: 'user-1',
        conversationId: 'thread-1',
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
    rmSync(seeded.dir, { recursive: true, force: true });
  }
});
