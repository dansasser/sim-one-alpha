import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeWebApiMessage } from '../api/connectors/web-api.js';
import { createChatPrompt } from '../api/routes/chat-prompt.js';

test('chat prompt requires minimal tool flow before answering', () => {
  const event = normalizeWebApiMessage({
    text: 'What can you do?',
    actorId: 'local-user',
    conversationId: 'local-thread',
  });

  const prompt = createChatPrompt(event);

  assert.match(prompt, /load_protocols/);
  assert.doesNotMatch(prompt, /Use retrieve_context/);
  assert.match(prompt, /Do not perform web search directly/);
  assert.match(prompt, /agent: "researcher"/);
  assert.match(prompt, /researcher owns web_research/);
  assert.match(prompt, /providerFailures/);
  assert.match(prompt, /retrieve_memory/);
  assert.match(prompt, /placeholder/);
  assert.match(prompt, /What can you do\?/);
});

test('chat prompt excludes sensitive event context and raw payloads', () => {
  const event = normalizeWebApiMessage({
    text: 'Handle this safely.',
    actorId: 'secret-actor-id',
    actorDisplayName: 'Visible User',
    conversationId: 'secret-conversation-id',
    clientId: 'secret-client-id',
    projectId: 'secret-project-id',
    workflow: 'visible-workflow',
    task: 'visible-task',
    raw: {
      token: 'secret-raw-token',
    },
  });

  const prompt = createChatPrompt(event);

  assert.match(prompt, /Handle this safely\./);
  assert.match(prompt, /Visible User/);
  assert.match(prompt, /visible-workflow/);
  assert.match(prompt, /visible-task/);
  assert.doesNotMatch(prompt, /secret-actor-id/);
  assert.doesNotMatch(prompt, /secret-conversation-id/);
  assert.doesNotMatch(prompt, /secret-client-id/);
  assert.doesNotMatch(prompt, /secret-project-id/);
  assert.doesNotMatch(prompt, /secret-raw-token/);
});

test('chat prompt carries the non-secret event id without exposing an auth admission capability', () => {
  const event = normalizeWebApiMessage({
    text: 'Authenticate GitHub.',
    actorId: 'local-user',
    conversationId: 'local-thread',
  });

  const prompt = createChatPrompt(event);

  assert.ok(prompt.includes(event.id));
  assert.doesNotMatch(prompt, /admissionId/i);
});

test('chat prompt directs Telegram group authorization to a private bot chat', () => {
  const event = normalizeWebApiMessage({
    text: 'Authenticate GitHub from a group.',
    actorId: 'telegram-user',
    conversationId: 'telegram-group',
  });
  const prompt = createChatPrompt(event, { githubAuthRequiresPrivateChat: true });

  assert.match(prompt, /GitHub authorization.*private chat/i);
  assert.match(prompt, /do not attempt.*GitHub auth/i);
});
