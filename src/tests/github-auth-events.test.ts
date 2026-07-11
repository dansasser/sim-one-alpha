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

  for (const [field, value] of [
    ['deviceCode', 'device-secret'],
    ['token', 'raw-token'],
  ] as const) {
    assert.throws(() => createCodingWorkerEvent({
      type: 'coding.github.auth.failed',
      taskId: 'event-auth-1',
      [field]: value,
    } as never), new RegExp(field));
  }

  for (const field of ['userCode', 'verificationUri', 'deviceCode', 'accessToken', 'authorization', 'token']) {
    assert.throws(() => createCodingWorkerEvent({
      type: 'coding.github.auth.failed',
      taskId: 'event-auth-1',
      error: { [field]: 'secret' },
    } as never), new RegExp(field));
  }
});

test('GitHub auth progress events reject normalized secret-key variants at any depth', () => {
  const unsafePayloads = [
    { user_code: 'WXYZ-1234' },
    { 'user-code': 'WXYZ-1234' },
    { UserCode: 'WXYZ-1234' },
    { access_token: 'secret' },
    { 'access-token': 'secret' },
    { Authorization: 'Bearer secret' },
    { nested: [{ DEVICE_CODE: 'secret' }] },
  ];

  for (const unsafe of unsafePayloads) {
    assert.throws(() => createCodingWorkerEvent({
      type: 'coding.github.auth.failed',
      taskId: 'event-auth-normalized-key',
      details: unsafe,
    } as never), /must not expose private model context/);
  }
});
