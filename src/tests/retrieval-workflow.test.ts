import assert from 'node:assert/strict';
import test from 'node:test';
import type { MemoryProvider } from '../memory/memory-provider.js';
import type { RagProvider, WebFetchResult } from '../rag/providers.js';
import { estimateTextTokens } from '../session/context-budget.js';
import type { RagQuery, RetrievedContext } from '../types/index.js';
import { retrieveContext } from '../workflows/retrieval.js';

test('retrieve_context tool reads Ollama search configuration at execution time', async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = {
    GOROMBO_WEB_SEARCH_PROVIDER: process.env.GOROMBO_WEB_SEARCH_PROVIDER,
    OLLAMA_API_KEY: process.env.OLLAMA_API_KEY,
    OLLAMA_CLOUD_API_KEY: process.env.OLLAMA_CLOUD_API_KEY,
    OLLAMA_WEB_SEARCH_BASE_URL: process.env.OLLAMA_WEB_SEARCH_BASE_URL,
  };

  const requests: Array<{ url: string; init?: RequestInit }> = [];

  try {
    delete process.env.OLLAMA_API_KEY;
    delete process.env.OLLAMA_CLOUD_API_KEY;
    process.env.GOROMBO_WEB_SEARCH_PROVIDER = 'ollama';
    process.env.OLLAMA_WEB_SEARCH_BASE_URL = 'https://ollama.test';

    const module = (await import(`../tools/rag-tool.js?late-env=${Date.now()}`)) as typeof import('../tools/rag-tool.js');
    process.env.OLLAMA_API_KEY = 'late-key';
    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          results: [
            {
              title: 'Ollama Search Docs',
              url: 'https://docs.ollama.com/capabilities/web-search',
              content: 'Ollama web search API documentation.',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    };

    const result = JSON.parse(
      await module.retrieveContextTool.execute({
        eventId: 'event-1',
        text: 'ollama web search api',
        actorId: 'user-1',
        conversationId: 'thread-1',
      }),
    );

    assert.equal(requests[0]?.url, 'https://ollama.test/api/web_search');
    assert.equal((requests[0]?.init?.headers as Record<string, string>).Authorization, 'Bearer late-key');
    assert.equal(result.contexts[0]?.metadata?.provider, 'ollama');
    assert.equal(result.contexts[0]?.title, 'Ollama Search Docs');
  } finally {
    restoreEnv(originalEnv);
    globalThis.fetch = originalFetch;
  }
});

test('retrieve_context tool forwards retrieval budget controls', async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = {
    GOROMBO_WEB_SEARCH_PROVIDER: process.env.GOROMBO_WEB_SEARCH_PROVIDER,
    OLLAMA_API_KEY: process.env.OLLAMA_API_KEY,
    OLLAMA_CLOUD_API_KEY: process.env.OLLAMA_CLOUD_API_KEY,
    OLLAMA_WEB_SEARCH_BASE_URL: process.env.OLLAMA_WEB_SEARCH_BASE_URL,
  };

  process.env.GOROMBO_WEB_SEARCH_PROVIDER = 'ollama';
  process.env.OLLAMA_API_KEY = 'test-key';
  process.env.OLLAMA_WEB_SEARCH_BASE_URL = 'https://ollama.test';

  const module = (await import(`../tools/rag-tool.js?budget-controls=${Date.now()}`)) as typeof import('../tools/rag-tool.js');

  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              title: 'Long Search Result',
              url: 'https://example.com/long-result',
              content: 'alpha '.repeat(200),
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );

    const result = JSON.parse(
      await module.retrieveContextTool.execute({
        eventId: 'event-1',
        text: 'Use web search for source-backed context.',
        actorId: 'user-1',
        conversationId: 'thread-1',
        maxContextTokens: 25,
        webFetch: 'never',
        limit: 1,
      }),
    );

    assert.equal(result.metadata?.budget?.maxContextTokens, 25);
    assert.equal(result.contexts[0]?.metadata?.truncated, true);
  } finally {
    restoreEnv(originalEnv);
    globalThis.fetch = originalFetch;
  }
});

test('retrieval workflow selects web search for source-backed prompts', async () => {
  const calls = {
    memory: 0,
    web: 0,
    documentIndex: 0,
  };
  const memoryProvider: MemoryProvider = {
    retrieve: async () => {
      calls.memory += 1;
      return [];
    },
  };
  const webProvider: RagProvider = {
    id: 'web-search',
    name: 'test-web',
    retrieve: async (query: RagQuery) => {
      calls.web += 1;
      assert.deepEqual(query.providers, ['memory', 'web-search']);
      return [
        makeContext({
          id: 'web:event-1:0',
          provider: 'web-search',
          title: 'Official source',
          content: 'Source backed result.',
          score: 0.8,
        }),
      ];
    },
  };
  const documentIndexProvider: RagProvider = {
    id: 'document-index',
    name: 'test-docs',
    retrieve: async () => {
      calls.documentIndex += 1;
      return [];
    },
  };

  const result = await retrieveContext(
    {
      eventId: 'event-1',
      text: 'Find the official Ollama web search API docs URL.',
      actorId: 'user-1',
      conversationId: 'thread-1',
      caller: 'researcher',
    },
    {
      memoryProvider,
      providers: [webProvider, documentIndexProvider],
    },
  );

  assert.equal(calls.memory, 1);
  assert.equal(calls.web, 1);
  assert.equal(calls.documentIndex, 0);
  assert.deepEqual(result.query.providers, ['memory', 'web-search']);
  assert.equal(result.contexts[0]?.title, 'Official source');
});

test('retrieval workflow enriches top web results with fetched page content', async () => {
  const fetchCalls: string[] = [];
  const webProvider: RagProvider & { fetchPage(url: string): Promise<WebFetchResult> } = {
    id: 'web-search',
    name: 'test-web',
    retrieve: async () => [
      makeContext({
        id: 'web:event-1:0',
        provider: 'web-search',
        title: 'Search Snippet',
        content: 'Short search snippet.',
        score: 0.8,
        metadata: {
          provider: 'test-web',
          url: 'https://example.com/full-page',
        },
      }),
    ],
    fetchPage: async (url: string) => {
      fetchCalls.push(url);
      return {
        title: 'Fetched Page',
        url,
        content: 'Fetched page content with enough detail to replace the original snippet.',
        links: ['https://example.com/related'],
        provider: 'test-web',
        retrievedAt: '2026-06-08T00:00:00.000Z',
      };
    },
  };

  const result = await retrieveContext(
    {
      eventId: 'event-1',
      text: 'Use web search for the current source.',
      actorId: 'user-1',
      conversationId: 'thread-1',
      caller: 'researcher',
      providers: ['web-search'],
      webFetch: 'always',
      fetchTopK: 1,
      maxContextTokens: 1_000,
    },
    {
      memoryProvider: emptyMemoryProvider,
      providers: [webProvider],
    },
  );

  assert.deepEqual(fetchCalls, ['https://example.com/full-page']);
  assert.equal(result.contexts[0]?.title, 'Fetched Page');
  assert.match(result.contexts[0]?.content ?? '', /Fetched page content/);
  assert.equal(result.contexts[0]?.metadata?.webFetch, 'fetched');
  assert.equal(result.contexts[0]?.metadata?.searchSnippet, 'Short search snippet.');
  assert.deepEqual(result.contexts[0]?.metadata?.links, ['https://example.com/related']);
});

test('retrieval workflow packs returned contexts inside the requested token budget', async () => {
  const webProvider: RagProvider = {
    id: 'web-search',
    name: 'test-web',
    retrieve: async () => [
      makeContext({
        id: 'web:event-1:0',
        provider: 'web-search',
        title: 'Long result',
        content: 'alpha '.repeat(200),
        score: 0.9,
      }),
      makeContext({
        id: 'web:event-1:1',
        provider: 'web-search',
        title: 'Second result',
        content: 'beta '.repeat(200),
        score: 0.8,
      }),
    ],
  };

  const result = await retrieveContext(
    {
      eventId: 'event-1',
      text: 'Use web search for source-backed context.',
      actorId: 'user-1',
      conversationId: 'thread-1',
      caller: 'researcher',
      providers: ['web-search'],
      webFetch: 'never',
      maxContextTokens: 25,
      limit: 5,
    },
    {
      memoryProvider: emptyMemoryProvider,
      providers: [webProvider],
    },
  );

  const usedContextTokens = result.contexts.reduce((total, context) => total + estimateTextTokens(context.content), 0);

  assert.ok(result.contexts.length >= 1);
  assert.ok(usedContextTokens <= 25);
  assert.equal(result.contexts[0]?.metadata?.truncated, true);
  assert.equal(result.metadata?.budget?.maxContextTokens, 25);
  assert.equal(result.metadata?.budget?.usedContextTokens, usedContextTokens);
});

test('retrieval workflow reads string budget controls from environment values', async () => {
  const fetchCalls: string[] = [];
  const webProvider: RagProvider & { fetchPage(url: string): Promise<WebFetchResult> } = {
    id: 'web-search',
    name: 'test-web',
    retrieve: async () => [
      makeContext({
        id: 'web:event-1:0',
        provider: 'web-search',
        title: 'First',
        content: 'alpha '.repeat(50),
        score: 0.9,
        metadata: {
          url: 'https://example.com/first',
        },
      }),
      makeContext({
        id: 'web:event-1:1',
        provider: 'web-search',
        title: 'Second',
        content: 'beta '.repeat(50),
        score: 0.8,
        metadata: {
          url: 'https://example.com/second',
        },
      }),
    ],
    fetchPage: async (url: string) => {
      fetchCalls.push(url);
      return {
        title: url,
        url,
        content: url.includes('first') ? 'first fetched content' : 'second fetched content',
        links: [],
        provider: 'test-web',
        retrievedAt: '2026-06-08T00:00:00.000Z',
      };
    },
  };

  const result = await retrieveContext(
    {
      eventId: 'event-1',
      text: 'Use web search for an official source.',
      actorId: 'user-1',
      conversationId: 'thread-1',
      caller: 'researcher',
      providers: ['web-search'],
      webFetch: 'always',
      limit: 2,
    },
    {
      env: {
        GOROMBO_RAG_MAX_CONTEXT_TOKENS: '13',
        GOROMBO_RAG_WEB_FETCH_TOP_K: '2',
      },
      memoryProvider: emptyMemoryProvider,
      providers: [webProvider],
    },
  );

  assert.deepEqual(fetchCalls, ['https://example.com/first', 'https://example.com/second']);
  assert.equal(result.metadata?.budget?.maxContextTokens, 13);
  assert.ok((result.metadata?.budget?.usedContextTokens ?? Number.POSITIVE_INFINITY) <= 13);
});

test('retrieval workflow honors an explicit zero web fetch budget', async () => {
  const webProvider: RagProvider & { fetchPage(url: string): Promise<WebFetchResult> } = {
    id: 'web-search',
    name: 'test-web',
    retrieve: async () => [
      makeContext({
        id: 'web:event-1:0',
        provider: 'web-search',
        title: 'Search Snippet',
        content: 'Short search snippet.',
        score: 0.8,
        metadata: {
          provider: 'test-web',
          url: 'https://example.com/full-page',
        },
      }),
    ],
    fetchPage: async () => {
      throw new Error('fetchPage should not run when fetchTopK is zero');
    },
  };

  const result = await retrieveContext(
    {
      eventId: 'event-1',
      text: 'Use web search for the current source.',
      actorId: 'user-1',
      conversationId: 'thread-1',
      caller: 'researcher',
      providers: ['web-search'],
      webFetch: 'always',
      fetchTopK: 0,
    },
    {
      memoryProvider: emptyMemoryProvider,
      providers: [webProvider],
    },
  );

  assert.equal(result.metadata?.webFetch?.attempted, 0);
  assert.equal(result.contexts[0]?.title, 'Search Snippet');
  assert.equal(result.contexts[0]?.metadata?.webFetch, undefined);
});

test('retrieval workflow records web search failures without failing the whole retrieval', async () => {
  const memoryProvider: MemoryProvider = {
    retrieve: async () => [
      makeContext({
        id: 'memory:thread-1',
        provider: 'memory',
        title: 'Memory fallback',
        content: 'Memory context remains available.',
        score: 0.25,
      }),
    ],
  };
  const webProvider: RagProvider = {
    id: 'web-search',
    name: 'test-web',
    retrieve: async () => {
      throw new Error('search provider unavailable');
    },
  };

  const result = await retrieveContext(
    {
      eventId: 'event-1',
      text: 'Use web search to find the official source.',
      actorId: 'user-1',
      conversationId: 'thread-1',
      caller: 'researcher',
    },
    {
      memoryProvider,
      providers: [webProvider],
    },
  );

  assert.equal(result.contexts[0]?.title, 'Memory fallback');
  assert.deepEqual(result.metadata?.providerFailures, [
    {
      provider: 'web-search',
      name: 'test-web',
      message: 'search provider unavailable',
    },
  ]);
});

test('retrieval workflow rejects web search outside the researcher boundary', async () => {
  await assert.rejects(
    retrieveContext(
      {
        eventId: 'event-1',
        text: 'Find the official source.',
        actorId: 'user-1',
        conversationId: 'thread-1',
        caller: 'orchestrator',
      },
      {
        memoryProvider: emptyMemoryProvider,
        providers: [],
      },
    ),
    /Web search retrieval is restricted to the researcher subagent or research workflow/,
  );
});

function restoreEnv(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

const emptyMemoryProvider: MemoryProvider = {
  retrieve: async () => [],
};

function makeContext(context: RetrievedContext): RetrievedContext {
  return context;
}
