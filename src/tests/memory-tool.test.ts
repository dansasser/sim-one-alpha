import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { normalizeWebApiMessage } from '../api/connectors/web-api.js';
import { rememberMemoryLookupEvent, retrieveMemoryTool } from '../engine/tools/memory-tool.js';

test('retrieve_memory scopes lookup through a trusted registered event', async () => {
  const serializedParameters = JSON.stringify((retrieveMemoryTool as { parameters?: unknown }).parameters ?? {});
  assert.doesNotMatch(serializedParameters, /actorId/);
  assert.doesNotMatch(serializedParameters, /conversationId/);

  await assert.rejects(
    () =>
      retrieveMemoryTool.execute({
        eventId: `missing-${randomUUID()}`,
        text: 'missing event memory query',
      }),
    /trusted eventId persisted by chat ingress/,
  );

  const event = normalizeWebApiMessage({
    text: 'memory lookup boundary',
    actorId: 'trusted-memory-actor',
    conversationId: 'trusted-memory-conversation',
  });
  rememberMemoryLookupEvent(event);

  const result = JSON.parse(
    await retrieveMemoryTool.execute({
      eventId: event.id,
      text: `memory-tool-empty-${randomUUID()}`,
      actorId: 'model-controlled-actor',
      conversationId: 'model-controlled-conversation',
    } as never),
  ) as { contexts?: unknown[] };

  assert.deepEqual(result.contexts, []);
});
