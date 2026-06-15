import assert from 'node:assert/strict';
import test from 'node:test';
import { createEmbeddingClient } from '../rag/embeddings.js';

test('createEmbeddingClient falls back from local to cloud when local is unreachable', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push({ url: String(url), init });
    if (String(url).includes('localhost')) {
      return new Response(null, { status: 503 });
    }
    return new Response(
      JSON.stringify({
        data: [{ embedding: new Array(768).fill(0.1) }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  const originalEnv = { ...process.env };
  try {
    process.env.OLLAMA_LOCAL_BASE_URL = 'http://localhost:11434/v1';
    process.env.OLLAMA_LOCAL_API_KEY = 'local-key';
    process.env.OLLAMA_CLOUD_BASE_URL = 'https://ollama.test/v1';
    process.env.OLLAMA_API_KEY = 'cloud-key';

    const client = createEmbeddingClient({ fetch: fakeFetch });
    const vector = await client.embed('hello world');

    assert.equal(vector.length, 768);
    assert.ok(requests.length >= 1);
    assert.ok(requests.some((request) => request.url.includes('localhost')));
    assert.ok(requests.some((request) => request.url.includes('ollama.test')));
  } finally {
    process.env = originalEnv;
  }
});

test('createEmbeddingClient truncates long input to embedding budget', async () => {
  const fakeFetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = init?.body ? JSON.parse(String(init.body)) : { input: [] };
    return new Response(
      JSON.stringify({
        data: body.input.map(() => ({ embedding: new Array(768).fill(0.1) })),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  const originalEnv = { ...process.env };
  try {
    process.env.OLLAMA_LOCAL_BASE_URL = 'http://localhost:11434/v1';
    process.env.OLLAMA_LOCAL_API_KEY = 'local-key';

    const client = createEmbeddingClient({ fetch: fakeFetch });
    const longText = 'word '.repeat(10_000);
    const vector = await client.embed(longText);

    assert.equal(vector.length, 768);
  } finally {
    process.env = originalEnv;
  }
});
