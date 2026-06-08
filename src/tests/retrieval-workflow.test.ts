import assert from 'node:assert/strict';
import test from 'node:test';

test('retrieve_context tool reads Ollama search configuration at execution time', async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = {
    GOROMBO_WEB_SEARCH_PROVIDER: process.env.GOROMBO_WEB_SEARCH_PROVIDER,
    OLLAMA_API_KEY: process.env.OLLAMA_API_KEY,
    OLLAMA_CLOUD_API_KEY: process.env.OLLAMA_CLOUD_API_KEY,
    OLLAMA_WEB_SEARCH_BASE_URL: process.env.OLLAMA_WEB_SEARCH_BASE_URL,
  };

  delete process.env.OLLAMA_API_KEY;
  delete process.env.OLLAMA_CLOUD_API_KEY;
  process.env.GOROMBO_WEB_SEARCH_PROVIDER = 'ollama';
  process.env.OLLAMA_WEB_SEARCH_BASE_URL = 'https://ollama.test';

  const module = (await import(`../tools/rag-tool.js?late-env=${Date.now()}`)) as typeof import('../tools/rag-tool.js');
  const requests: Array<{ url: string; init?: RequestInit }> = [];

  try {
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

function restoreEnv(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
