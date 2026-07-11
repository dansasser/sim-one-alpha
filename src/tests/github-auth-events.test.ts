import assert from 'node:assert/strict';
import test from 'node:test';
import { createCodingWorkerEvent } from '../engine/workers/coding-worker/events/coding-worker-events.js';

test('GitHub auth progress events retain opaque state but reject device-code and token fields', () => {
  assert.doesNotThrow(() => createCodingWorkerEvent({
    type: 'coding.github.auth.challenge_available',
    taskId: 'event-auth-1',
    status: 'authorization_pending',
    evidence: ['session-1'],
  }));

  assert.throws(() => createCodingWorkerEvent({
    type: 'coding.github.auth.challenge_available',
    taskId: 'event-auth-1',
    status: 'authorization_pending',
    userCode: 'WXYZ-1234',
  } as never), /userCode/);
  assert.throws(() => createCodingWorkerEvent({
    type: 'coding.github.auth.failed',
    taskId: 'event-auth-1',
    error: { authorization: 'Bearer secret' },
  } as never), /authorization/);
});
