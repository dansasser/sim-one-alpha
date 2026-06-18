import assert from 'node:assert/strict';
import test from 'node:test';
import { createEmbeddingClient } from '../rag/embeddings.js';

test('createEmbeddingClient tries cloud first and falls back to onnx-local when cloud fails', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push({ url: String(url), init });
    if (String(url).includes('ollama.test')) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
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

    assert.equal(vector.length, 384);
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

    assert.equal(vector.length, 384);
  } finally {
    process.env = originalEnv;
  }
});

test('createEmbeddingClient cloud success avoids local fallback', async () => {
  let cloudHits = 0;
  const fakeFetch = async (url: string | URL | Request): Promise<Response> => {
    if (String(url).includes('ollama.test')) {
      cloudHits++;
      return new Response(JSON.stringify({ embeddings: [new Array(768).fill(0.1)] }), { status: 200 });
    }
    return new Response(null, { status: 503 });
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
    assert.equal(cloudHits, 1);
  } finally {
    process.env = originalEnv;
  }
});

test('createEmbeddingClient embedWithOutcome reports provider on success', async () => {
  let cloudHits = 0;
  const fakeFetch = async (url: string | URL | Request): Promise<Response> => {
    if (String(url).includes('ollama.test')) {
      cloudHits++;
      return new Response(JSON.stringify({ embeddings: [new Array(768).fill(0.1)] }), { status: 200 });
    }
    return new Response(null, { status: 503 });
  };

  const originalEnv = { ...process.env };
  try {
    process.env.OLLAMA_LOCAL_BASE_URL = 'http://localhost:11434/v1';
    process.env.OLLAMA_LOCAL_API_KEY = 'local-key';
    process.env.OLLAMA_CLOUD_BASE_URL = 'https://ollama.test/v1';
    process.env.OLLAMA_API_KEY = 'cloud-key';

    const client = createEmbeddingClient({ fetch: fakeFetch });
    const outcome = await client.embedWithOutcome('hello world');

    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.result.provider, 'cloud');
    assert.equal(outcome.result.modelId, 'nomic-embed-text');
    assert.equal(cloudHits, 1);
  } finally {
    process.env = originalEnv;
  }
});

test('createEmbeddingClient embedWithOutcome reports onnx-local on cloud failure', async () => {
  const fakeFetch = async (_url: string | URL | Request): Promise<Response> => {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  };

  const originalEnv = { ...process.env };
  try {
    process.env.OLLAMA_CLOUD_BASE_URL = 'https://ollama.test/v1';
    process.env.OLLAMA_API_KEY = 'cloud-key';

    const client = createEmbeddingClient({ fetch: fakeFetch });
    const outcome = await client.embedWithOutcome('hello world');

    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.result.provider, 'onnx-local');
    assert.equal(outcome.result.modelId, 'all-minilm-l6-v2');
    assert.equal(outcome.result.vector.length, 384);
  } finally {
    process.env = originalEnv;
  }
});

test('createEmbeddingClient embedWithOutcome returns error when all providers fail', async () => {
  const fakeFetch = async (url: string | URL | Request): Promise<Response> => {
    if (String(url).includes('ollama.local')) {
      return new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 });
    }
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  };

  const originalEnv = { ...process.env };
  try {
    process.env.OLLAMA_CLOUD_BASE_URL = 'https://ollama.test/v1';
    process.env.OLLAMA_API_KEY = 'cloud-key';
    process.env.OLLAMA_LOCAL_BASE_URL = 'https://ollama.local/v1';
    process.env.OLLAMA_LOCAL_API_KEY = 'local-key';
    process.env.GOROMBO_EMBEDDING_MODEL_PATH = '/nonexistent/model/dir';

    const client = createEmbeddingClient({ fetch: fakeFetch });
    const outcome = await client.embedWithOutcome('hello world');

    assert.equal(outcome.ok, false);
  } finally {
    process.env = originalEnv;
  }
});
