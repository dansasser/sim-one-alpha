import assert from 'node:assert/strict';
import test from 'node:test';
import type { RagProvider, WebFetchResult } from '../rag/providers.js';
import { InMemoryResearchCache } from '../workers/researcher/research/research-cache.js';
import type { RagQuery, RetrievedContext } from '../types/index.js';
import { buildResearchQueryPlan, runWebResearch } from '../workflows/web-research.js';

test('web research query plan expands based on research complexity', () => {
  assert.deepEqual(buildResearchQueryPlan('Find the official Ollama web search API docs URL.', 3), [
    'Find the official Ollama web search API docs URL.',
    'Find the official Ollama web search API docs URL. official documentation',
  ]);

  assert.deepEqual(buildResearchQueryPlan('Compare current web search options.', 2), [
    'Compare current web search options.',
    'Compare current web search options. latest',
  ]);
});

test('web research workflow reuses search and page cache across research runs', async () => {
  const cache = new InMemoryResearchCache();
  const calls = {
    search: 0,
    fetch: 0,
  };
  const provider = createWebProvider({
    retrieve: async (query) => {
      calls.search += 1;
      return [
        makeContext({
          id: `web:${calls.search}`,
          title: 'Official Docs',
          content: 'Short official search snippet.',
          url: 'https://example.com/docs',
          query,
        }),
      ];
    },
    fetchPage: async (url) => {
      calls.fetch += 1;
      return {
        title: 'Fetched Official Docs',
        url,
        content: 'Fetched official documentation page with enough detail for the researcher.',
        links: ['https://example.com/docs/reference'],
        provider: 'test-web',
        retrievedAt: '2026-06-08T00:00:00.000Z',
      };
    },
  });

  const first = await runWebResearch(
    {
      eventId: 'event-1',
      text: 'Find the official API docs URL.',
      actorId: 'user-1',
      conversationId: 'thread-1',
      maxQueries: 2,
      maxFetches: 1,
      webFetch: 'always',
      minSources: 1,
    },
    {
      cache,
      webProvider: provider,
    },
  );
  const second = await runWebResearch(
    {
      eventId: 'event-2',
      text: 'Find the official API docs URL.',
      actorId: 'user-1',
      conversationId: 'thread-1',
      maxQueries: 2,
      maxFetches: 1,
      webFetch: 'always',
      minSources: 1,
    },
    {
      cache,
      webProvider: provider,
    },
  );

  assert.equal(first.status, 'completed');
  assert.equal(first.cache.searchMisses, 1);
  assert.equal(first.cache.pageMisses, 1);
  assert.equal(second.cache.searchHits, 1);
  assert.equal(second.cache.pageHits, 1);
  assert.equal(calls.search, 1);
  assert.equal(calls.fetch, 1);
  assert.equal(second.sources[0]?.url, 'https://example.com/docs');
});

test('web research workflow runs multiple searches for complex research prompts', async () => {
  const queries: string[] = [];
  const provider = createWebProvider({
    retrieve: async (query) => {
      queries.push(query.text);
      return [
        makeContext({
          id: `web:${queries.length}`,
          title: `Source ${queries.length}`,
          content: `Source ${queries.length} content.`,
          url: `https://example.com/source-${queries.length}`,
          query,
        }),
      ];
    },
  });

  const result = await runWebResearch(
    {
      eventId: 'event-1',
      text: 'Compare current web search options with sources.',
      actorId: 'user-1',
      conversationId: 'thread-1',
      maxQueries: 3,
      maxFetches: 0,
      webFetch: 'never',
    },
    {
      cache: new InMemoryResearchCache(),
      webProvider: provider,
    },
  );

  assert.equal(result.status, 'completed');
  assert.equal(result.queriesRun.length, 2);
  assert.equal(queries.length, 2);
  assert.equal(result.sources.length, 2);
  assert.ok(result.confidence > 0.6);
});

test('web research workflow counts unique sources before stopping', async () => {
  const queries: string[] = [];
  const provider = createWebProvider({
    retrieve: async (query) => {
      queries.push(query.text);
      const duplicate = queries.length < 3;

      return [
        makeContext({
          id: `web:${queries.length}`,
          title: duplicate ? 'Duplicate Source' : 'Distinct Source',
          content: `Source ${queries.length} content.`,
          url: duplicate ? 'https://example.com/same-source' : 'https://example.com/distinct-source',
          query,
        }),
      ];
    },
  });

  const result = await runWebResearch(
    {
      eventId: 'event-1',
      text: 'Compare current web search options with sources.',
      actorId: 'user-1',
      conversationId: 'thread-1',
      maxQueries: 3,
      maxFetches: 0,
      webFetch: 'never',
      minSources: 2,
    },
    {
      cache: new InMemoryResearchCache(),
      webProvider: provider,
    },
  );

  assert.equal(result.status, 'completed');
  assert.equal(result.queriesRun.length, 3);
  assert.equal(queries.length, 3);
  assert.equal(result.sources.length, 2);
  assert.deepEqual(
    result.sources.map((source) => source.url),
    ['https://example.com/same-source', 'https://example.com/distinct-source'],
  );
});

test('web research workflow keeps searching after fetch budget is exhausted', async () => {
  const queries: string[] = [];
  const fetchCalls: string[] = [];
  const provider = createWebProvider({
    retrieve: async (query) => {
      queries.push(query.text);
      return [
        makeContext({
          id: `web:${queries.length}`,
          title: `Source ${queries.length}`,
          content: `Source ${queries.length} content.`,
          url: `https://example.com/source-${queries.length}`,
          query,
        }),
      ];
    },
    fetchPage: async (url) => {
      fetchCalls.push(url);
      return {
        title: `Fetched ${url}`,
        url,
        content: `Fetched content for ${url}.`,
        links: [],
        provider: 'test-web',
        retrievedAt: '2026-06-08T00:00:00.000Z',
      };
    },
  });

  const result = await runWebResearch(
    {
      eventId: 'event-1',
      text: 'Compare current web search options with sources.',
      actorId: 'user-1',
      conversationId: 'thread-1',
      maxQueries: 3,
      maxFetches: 1,
      minSources: 3,
      webFetch: 'always',
    },
    {
      cache: new InMemoryResearchCache(),
      webProvider: provider,
    },
  );

  assert.equal(result.queriesRun.length, 3);
  assert.equal(queries.length, 3);
  assert.equal(fetchCalls.length, 1);
  assert.equal(result.budget.maxFetches, 1);
});

test('web research fresh mode bypasses existing search and page cache reads', async () => {
  const cache = new InMemoryResearchCache();
  const calls = {
    search: 0,
    fetch: 0,
  };
  const provider = createWebProvider({
    retrieve: async (query) => {
      calls.search += 1;
      return [
        makeContext({
          id: `web:${calls.search}`,
          title: 'Official Docs',
          content: 'Short official search snippet.',
          url: 'https://example.com/docs',
          query,
        }),
      ];
    },
    fetchPage: async (url) => {
      calls.fetch += 1;
      return {
        title: 'Fetched Official Docs',
        url,
        content: `Fetched official documentation page ${calls.fetch}.`,
        links: [],
        provider: 'test-web',
        retrievedAt: '2026-06-08T00:00:00.000Z',
      };
    },
  });

  await runWebResearch(
    {
      eventId: 'event-1',
      text: 'Find the official API docs URL.',
      actorId: 'user-1',
      conversationId: 'thread-1',
      maxQueries: 1,
      maxFetches: 1,
      webFetch: 'always',
    },
    {
      cache,
      webProvider: provider,
    },
  );

  const fresh = await runWebResearch(
    {
      eventId: 'event-2',
      text: 'Find the official API docs URL.',
      actorId: 'user-1',
      conversationId: 'thread-1',
      maxQueries: 1,
      maxFetches: 1,
      webFetch: 'always',
      freshness: 'fresh',
    },
    {
      cache,
      webProvider: provider,
    },
  );

  assert.equal(calls.search, 2);
  assert.equal(calls.fetch, 2);
  assert.equal(fresh.cache.searchHits, 0);
  assert.equal(fresh.cache.pageHits, 0);
});

test('web research workflow applies deep research defaults with bounded iterations', async () => {
  const queries: string[] = [];
  const provider = createWebProvider({
    retrieve: async (query) => {
      queries.push(query.text);
      return [
        makeContext({
          id: `web:${queries.length}`,
          title: `Deep Source ${queries.length}`,
          content: `Deep source ${queries.length} content.`,
          url: `https://example.com/deep-source-${queries.length}`,
          query,
        }),
      ];
    },
  });

  const result = await runWebResearch(
    {
      eventId: 'event-1',
      text: 'Deep research current web search options with sources.',
      actorId: 'user-1',
      conversationId: 'thread-1',
      depth: 'deep',
      webFetch: 'never',
    },
    {
      cache: new InMemoryResearchCache(),
      webProvider: provider,
    },
  );

  assert.equal(result.status, 'completed');
  assert.equal(result.budget.depth, 'deep');
  assert.equal(result.budget.maxQueries, 6);
  assert.equal(result.budget.minSources, 5);
  assert.equal(result.budget.maxIterations, 3);
  assert.ok(result.budget.iterationsRun >= 2);
  assert.ok(result.budget.iterationsRun <= result.budget.maxIterations);
  assert.ok(result.queriesRun.length >= 5);
  assert.ok(queries.length >= 5);
  assert.equal(result.sources.length, result.queriesRun.length);
});

function createWebProvider(input: {
  retrieve(query: RagQuery): Promise<RetrievedContext[]>;
  fetchPage?: (url: string) => Promise<WebFetchResult>;
}): RagProvider & { fetchPage(url: string): Promise<WebFetchResult> } {
  return {
    id: 'web-search',
    name: 'test-web',
    retrieve: input.retrieve,
    fetchPage: input.fetchPage ?? (async () => {
      throw new Error('fetchPage was not expected');
    }),
  };
}

function makeContext(input: {
  id: string;
  title: string;
  content: string;
  url: string;
  query: RagQuery;
}): RetrievedContext {
  return {
    id: input.id,
    provider: 'web-search',
    title: input.title,
    content: input.content,
    score: 0.9,
    metadata: {
      provider: 'test-web',
      url: input.url,
      query: input.query.text,
    },
  };
}
