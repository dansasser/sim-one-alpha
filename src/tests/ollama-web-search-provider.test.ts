import assert from 'node:assert/strict';
import test from 'node:test';
import { OllamaWebSearchProvider, createDefaultWebSearchProvider } from '../engine/rag/providers.js';

test('Ollama web search provider normalizes web search results', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const provider = new OllamaWebSearchProvider({
    apiKey: 'test-key',
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return jsonResponse({
        results: [
          {
            title: 'Ollama Web Search',
            url: 'https://docs.ollama.com/capabilities/web-search',
            content: 'Ollama provides web_search and web_fetch APIs.',
          },
        ],
      });
    },
  });

  const contexts = await provider.retrieve({
    eventId: 'event-1',
    text: 'ollama web search api',
    actorId: 'user-1',
    conversationId: 'thread-1',
    limit: 3,
  });

  assert.equal(requests[0]?.url, 'https://ollama.com/api/web_search');
  assert.equal(requests[0]?.init?.method, 'POST');
  assert.equal((requests[0]?.init?.headers as Record<string, string>).Authorization, 'Bearer test-key');
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    query: 'ollama web search api',
    max_results: 3,
  });
  assert.deepEqual(contexts, [
    {
      id: 'ollama-web:event-1:0',
      provider: 'web-search',
      title: 'Ollama Web Search',
      content: 'Ollama provides web_search and web_fetch APIs.',
      score: 0.8,
      metadata: {
        provider: 'ollama',
        url: 'https://docs.ollama.com/capabilities/web-search',
      },
    },
  ]);
});

test('Ollama web search provider clamps max results to Ollama limit', async () => {
  let body = '';
  const provider = new OllamaWebSearchProvider({
    apiKey: 'test-key',
    fetch: async (_url: string | URL | Request, init?: RequestInit) => {
      body = String(init?.body);
      return jsonResponse({ results: [] });
    },
  });

  await provider.retrieve({
    eventId: 'event-1',
    text: 'agent search',
    actorId: 'user-1',
    conversationId: 'thread-1',
    limit: 99,
  });

  assert.equal(JSON.parse(body).max_results, 10);
});

test('Ollama web fetch provider returns fetched page content', async () => {
  const provider = new OllamaWebSearchProvider({
    apiKey: 'test-key',
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(url), 'https://ollama.com/api/web_fetch');
      assert.deepEqual(JSON.parse(String(init?.body)), {
        url: 'https://docs.ollama.com',
      });

      return jsonResponse({
        title: 'Ollama Docs',
        content: 'Main docs content',
        links: ['https://docs.ollama.com/capabilities/web-search'],
      });
    },
  });

  const result = await provider.fetchPage('https://docs.ollama.com');

  assert.deepEqual(result, {
    title: 'Ollama Docs',
    url: 'https://docs.ollama.com',
    content: 'Main docs content',
    links: ['https://docs.ollama.com/capabilities/web-search'],
    provider: 'ollama',
    retrievedAt: result.retrievedAt,
  });
  assert.match(result.retrievedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('Ollama web search provider times out stalled requests', async () => {
  const provider = new OllamaWebSearchProvider({
    apiKey: 'test-key',
    timeoutMs: 1,
    fetch: async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      }),
  });

  await assert.rejects(
    provider.retrieve({
      eventId: 'event-1',
      text: 'ollama web search api',
      actorId: 'user-1',
      conversationId: 'thread-1',
    }),
    /timed out after 1ms/,
  );
});

test('default web search provider uses Ollama when an Ollama API key is configured', () => {
  const provider = createDefaultWebSearchProvider({
    OLLAMA_API_KEY: 'test-key',
  });

  assert.equal(provider.id, 'web-search');
  assert.equal(provider.name, 'ollama');
});

test('default web search provider falls back to placeholder without a key', async () => {
  const provider = createDefaultWebSearchProvider({});
  const contexts = await provider.retrieve({
    eventId: 'event-1',
    text: 'anything',
    actorId: 'user-1',
    conversationId: 'thread-1',
  });

  assert.equal(provider.id, 'web-search');
  assert.equal(provider.name, 'placeholder');
  assert.match(contexts[0]?.content ?? '', /does not call external search yet/);
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json',
    },
  });
}
