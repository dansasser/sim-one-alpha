import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeWebApiMessage } from '../connectors/web-api.js';
import { createChatPrompt, createContextBudgetReport } from '../workflows/chat.js';

test('chat workflow prompt requires minimal tool flow before answering', () => {
  const event = normalizeWebApiMessage({
    text: 'What can you do?',
    actorId: 'local-user',
    conversationId: 'local-thread',
  });

  const prompt = createChatPrompt(event);

  assert.match(prompt, /load_protocols/);
  assert.match(prompt, /retrieve_context/);
  assert.match(prompt, /Ollama Search/);
  assert.match(prompt, /maxContextTokens/);
  assert.match(prompt, /webFetch/);
  assert.match(prompt, /agent: "researcher"/);
  assert.match(prompt, /multi-step web/);
  assert.match(prompt, /providerFailures/);
  assert.match(prompt, /retrieve_memory/);
  assert.match(prompt, /placeholder/);
  assert.match(prompt, /What can you do\?/);
});

test('chat workflow reports context budget for selected model', () => {
  const report = createContextBudgetReport('ollama-cloud/minimax-m3');

  assert.equal(report?.modelSpecifier, 'ollama-cloud/minimax-m3');
  assert.equal(report?.enforcedContextWindow, 524_288);
  assert.equal(report?.outputReserveTokens, 131_072);
  assert.equal(report?.usableInputTokens, 393_216);
  assert.equal(report?.status, 'normal');
});
