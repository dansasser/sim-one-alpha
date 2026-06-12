import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeWebApiMessage } from '../connectors/web-api.js';
import {
  createProtocolLookupEvent,
  forgetProtocolLookupEvent,
  rememberProtocolLookupEvent,
} from '../tools/protocol-tool.js';

test('protocol tool lookup event requires a persisted normalized event', () => {
  assert.throws(() => createProtocolLookupEvent({
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
  }), /No persisted normalized message event found/);
});

test('protocol tool lookup event resolves sensitive selectors from server-side event context', () => {
  const event = normalizeWebApiMessage({
    text: 'Use scoped protocols.',
    actorId: 'user-1',
    conversationId: 'conversation-1',
    threadId: 'thread-secret',
    clientId: 'client-secret',
    projectId: 'project-secret',
    workflow: 'research',
    task: 'source-check',
    raw: {
      token: 'raw-secret',
    },
  });

  rememberProtocolLookupEvent(event);

  try {
    const lookup = createProtocolLookupEvent({
      eventId: event.id,
      connector: 'telegram',
      messageKind: 'workflow.event',
      actorId: 'spoofed-user',
      conversationId: 'spoofed-conversation',
      threadId: 'spoofed-thread',
      clientId: 'spoofed-client',
      projectId: 'spoofed-project',
      workflow: 'spoofed-workflow',
      task: 'spoofed-task',
    });

    assert.equal(lookup.connector, 'web-api');
    assert.equal(lookup.kind, 'chat.message');
    assert.equal(lookup.actor.id, 'user-1');
    assert.equal(lookup.conversation.id, 'conversation-1');
    assert.equal(lookup.conversation.threadId, 'thread-secret');
    assert.deepEqual(lookup.context, {
      clientId: 'client-secret',
      projectId: 'project-secret',
      workflow: 'research',
      task: 'source-check',
    });
    assert.equal(lookup.raw, undefined);
  } finally {
    forgetProtocolLookupEvent(event.id);
  }
});
