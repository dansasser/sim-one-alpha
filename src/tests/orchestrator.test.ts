import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeWebApiMessage } from '../connectors/web-api.js';
import { createDefaultOrchestrator } from '../orchestrator/orchestrator.js';

test('orchestrator handles a simple chat event without external providers', async () => {
  const orchestrator = createDefaultOrchestrator();
  const response = await orchestrator.handle(
    normalizeWebApiMessage({
      text: 'Hello from the test suite',
      actorId: 'user-1',
      conversationId: 'conversation-1',
    }),
  );

  assert.equal(response.status, 'ok');
  assert.equal(response.routedTo, 'main-orchestrator');
  assert.ok(response.protocolBundle.protocols.length >= 1);
  assert.ok(response.retrievedContext.contexts.length >= 1);
  assert.deepEqual(response.toolCalls, ['protocol.load', 'rag.retrieve']);
});

test('default orchestrator uses Ollama search when an Ollama API key is configured', async () => {
  const orchestrator = createDefaultOrchestrator({
    env: {
      OLLAMA_API_KEY: 'test-key',
    },
    webSearchProvider: {
      id: 'web-search',
      name: 'ollama',
      retrieve: async () => [
        {
          id: 'ollama-web:event-1:0',
          provider: 'web-search',
          title: 'Ollama Search Result',
          content: 'Ollama search content',
          score: 0.8,
          metadata: {
            provider: 'ollama',
          },
        },
      ],
    },
  });
  const response = await orchestrator.handle(
    normalizeWebApiMessage({
      text: 'Hello from the test suite',
      actorId: 'user-1',
      conversationId: 'conversation-1',
    }),
  );

  assert.equal(response.retrievedContext.contexts.some((context) => context.metadata?.provider === 'ollama'), true);
});
