import assert from 'node:assert/strict';
import test from 'node:test';
import { createResearchPrompt } from '../workflows/research.js';

test('research workflow prompt instructs the researcher to use retrieval controls', () => {
  const prompt = createResearchPrompt({
    text: 'Find the official Ollama web search API docs URL.',
    actorId: 'user-1',
    conversationId: 'thread-1',
    maxContextTokens: 2_000,
    webFetch: 'always',
    fetchTopK: 2,
  });

  assert.match(prompt, /web_research/);
  assert.match(prompt, /maxContextTokens: 2000/);
  assert.match(prompt, /webFetch: "always"/);
  assert.match(prompt, /maxFetches: 2/);
  assert.match(prompt, /Compare sources/);
  assert.match(prompt, /providerFailures/);
  assert.match(prompt, /source URLs/);
  assert.match(prompt, /Find the official Ollama web search API docs URL/);
});
