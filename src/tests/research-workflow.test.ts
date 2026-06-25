import assert from 'node:assert/strict';
import test from 'node:test';
import { createResearchPrompt } from '../engine/workflows/research.js';

test('research workflow prompt instructs the researcher to use retrieval controls', () => {
  const prompt = createResearchPrompt({
    text: 'Find the official Ollama web search API docs URL.',
    actorId: 'user-1',
    conversationId: 'thread-1',
    depth: 'deep',
    maxContextTokens: 2_000,
    webFetch: 'always',
    fetchTopK: 2,
  });

  assert.match(prompt, /web_research/);
  assert.match(prompt, /depth: "deep"/);
  assert.match(prompt, /maxContextTokens: 2000/);
  assert.match(prompt, /webFetch: "always"/);
  assert.match(prompt, /maxFetches: 2/);
  assert.match(prompt, /Compare sources/);
  assert.match(prompt, /providerFailures/);
  assert.match(prompt, /source URLs/);
  assert.match(prompt, /Find the official Ollama web search API docs URL/);
});

test('research workflow prompt lets deep web research use depth defaults', () => {
  const prompt = createResearchPrompt({
    text: 'Do deep research on current AI search options.',
    depth: 'deep',
  });

  assert.match(prompt, /depth: "deep"/);
  assert.match(prompt, /omit it so web_research applies the selected depth defaults/);
  assert.doesNotMatch(prompt, /maxContextTokens:/);
  assert.doesNotMatch(prompt, /maxFetches:/);
  assert.doesNotMatch(prompt, /webFetch:/);
});
