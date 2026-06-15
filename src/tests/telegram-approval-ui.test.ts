import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  APPROVE_CALLBACK_PREFIX,
  DENY_CALLBACK_PREFIX,
  buildApprovalKeyboard,
  buildApprovalRequestMessage,
  buildApprovalResolvedMessage,
  escapeMarkdown,
  parseApprovalCallback,
} from '../connectors/telegram/approval-ui/index.js';
import type { CodingApprovalRecord } from '../workers/coding-worker/approvals/approval-types.js';

describe('telegram approval UI', () => {
  function makeRecord(status: CodingApprovalRecord['status'] = 'pending'): CodingApprovalRecord {
    return {
      request: {
        id: 'req-123',
        dedupeKey: 'dedupe-123',
        taskId: 'task-1',
        actionType: 'file.edit',
        summary: 'Edit file.txt',
        reason: 'Mutating workspace file.',
        risk: 'low',
        target: 'file.txt',
        createdAt: new Date().toISOString(),
      },
      status,
      updatedAt: new Date().toISOString(),
    };
  }

  it('builds an approval request message with required fields', () => {
    const message = buildApprovalRequestMessage(makeRecord());
    assert.match(message, /Approval requested/);
    assert.match(message, /Action:/);
    assert.match(message, /file\\.edit/);
    assert.match(message, /Summary:/);
    assert.match(message, /Edit file\\.txt/);
    assert.match(message, /Target:/);
    assert.match(message, /file\\.txt/);
    assert.match(message, /Risk:/);
    assert.match(message, /Request ID:/);
    assert.match(message, /req\\-123/);
  });

  it('escapes markdown characters in approval text', () => {
    const message = buildApprovalRequestMessage({
      request: {
        id: 'req-123',
        dedupeKey: 'dedupe-123',
        taskId: 'task-1',
        actionType: 'shell.execute',
        summary: 'Run rm -rf / (dangerous)',
        reason: 'Bash command.',
        risk: 'high',
        target: '`rm` command',
        createdAt: new Date().toISOString(),
      },
      status: 'pending',
      updatedAt: new Date().toISOString(),
    });
    assert.doesNotMatch(message, /[^\\]\(/);
  });

  it('can omit metadata from the request message', () => {
    const message = buildApprovalRequestMessage(makeRecord(), { includeMetadata: false });
    assert.doesNotMatch(message, /Request ID:/);
  });

  it('builds a resolved message for an approved record', () => {
    const record = makeRecord('approved');
    record.decision = {
      requestId: record.request.id,
      approved: true,
      decidedBy: 'operator-1',
      decidedAt: new Date().toISOString(),
      reason: 'Looks good.',
    };
    const message = buildApprovalResolvedMessage(record);
    assert.match(message, /Approval approved/);
    assert.match(message, /Decided by:/);
    assert.match(message, /operator\\-1/);
    assert.match(message, /Reason:/);
    assert.match(message, /Looks good\\./);
  });

  it('builds a resolved message for a denied record', () => {
    const record = makeRecord('denied');
    record.decision = {
      requestId: record.request.id,
      approved: false,
      decidedBy: 'operator-1',
      decidedAt: new Date().toISOString(),
    };
    const message = buildApprovalResolvedMessage(record);
    assert.match(message, /Approval denied/);
    assert.doesNotMatch(message, /Reason:/);
  });

  it('builds an inline keyboard with approve and deny buttons', () => {
    const keyboard = buildApprovalKeyboard('req-123');
    assert.equal(keyboard.length, 1);
    assert.equal(keyboard[0].length, 2);
    assert.equal(keyboard[0][0].text, '✅ Approve');
    assert.equal(keyboard[0][0].callback_data, `${APPROVE_CALLBACK_PREFIX}req-123`);
    assert.equal(keyboard[0][1].text, '❌ Deny');
    assert.equal(keyboard[0][1].callback_data, `${DENY_CALLBACK_PREFIX}req-123`);
  });

  it('parses approve callback payloads', () => {
    const parsed = parseApprovalCallback(`${APPROVE_CALLBACK_PREFIX}req-123`);
    assert.deepEqual(parsed, { requestId: 'req-123', approved: true });
  });

  it('parses deny callback payloads', () => {
    const parsed = parseApprovalCallback(`${DENY_CALLBACK_PREFIX}req-123`);
    assert.deepEqual(parsed, { requestId: 'req-123', approved: false });
  });

  it('returns undefined for unrecognized callback payloads', () => {
    assert.equal(parseApprovalCallback('unknown:req-123'), undefined);
  });

  it('exposes an escapeMarkdown helper', () => {
    assert.equal(escapeMarkdown('a_b'), 'a\\_b');
    assert.equal(escapeMarkdown('[link]'), '\\[link\\]');
  });
});
