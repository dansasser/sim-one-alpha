import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeWebApiMessage } from '../connectors/web-api.js';
import { createChatPrompt } from '../workflows/chat.js';

test('chat workflow prompt requires minimal tool flow before answering', () => {
  const event = normalizeWebApiMessage({
    text: 'What can you do?',
    actorId: 'local-user',
    conversationId: 'local-thread',
  });

  const prompt = createChatPrompt(event);

  assert.match(prompt, /load_protocols/);
  assert.match(prompt, /retrieve_context or retrieve_memory/);
  assert.match(prompt, /placeholder/);
  assert.match(prompt, /What can you do\?/);
});

