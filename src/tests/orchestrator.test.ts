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

