import assert from 'node:assert/strict';
import test from 'node:test';
import { createProtocolLookupEvent } from '../tools/protocol-tool.js';

test('protocol tool lookup event preserves normalized selectors', () => {
  const event = createProtocolLookupEvent({
    eventId: 'event-1',
    connector: 'web-api',
    messageKind: 'workflow.event',
    actorId: 'user-1',
    conversationId: 'conversation-1',
    threadId: 'thread-1',
    clientId: 'client-1',
    projectId: 'project-1',
    workflow: 'research',
    task: 'source-check',
  });

  assert.equal(event.id, 'event-1');
  assert.equal(event.connector, 'web-api');
  assert.equal(event.kind, 'workflow.event');
  assert.equal(event.actor.id, 'user-1');
  assert.equal(event.conversation.id, 'conversation-1');
  assert.equal(event.conversation.threadId, 'thread-1');
  assert.deepEqual(event.context, {
    clientId: 'client-1',
    projectId: 'project-1',
    workflow: 'research',
    task: 'source-check',
  });
});
