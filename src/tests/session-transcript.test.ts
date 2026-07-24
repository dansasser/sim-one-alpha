import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseOffset, type EventStreamStore } from '@flue/runtime/adapter';
import {
  GoromboSessionDatabase,
  type SessionNormalizedMessageRecord,
} from '../engine/session/session-database.js';
import {
  decodeTranscriptCursor,
  encodeTranscriptCursor,
  loadSessionTranscriptPage,
  projectSessionTranscript,
} from '../engine/session/session-transcript.js';

test('projects internal greeting and user exchanges without leaking nested or tool-result text', () => {
  const prompts = [
    prompt({
      eventId: 'prompt-greeting',
      text: 'This is an automatic SIM-ONE Alpha local Ratatui TUI startup event.',
      receivedAt: '2026-07-20T19:08:05.000Z',
      submissionId: 'submission-greeting',
      workflow: 'tui.startup-preflight',
    }),
    prompt({
      eventId: 'prompt-user-1',
      text: 'Explain the status',
      receivedAt: '2026-07-20T19:09:00.000Z',
      submissionId: 'submission-user-1',
    }),
  ];
  const events = [
    streamEvent('0000000000000000_0000000000000000', {
      type: 'operation_start',
      operationId: 'op-greeting',
      operationKind: 'prompt',
      submissionId: 'submission-greeting',
      eventIndex: 0,
      timestamp: '2026-07-20T19:08:05.100Z',
    }),
    streamEvent('0000000000000000_0000000000000001', {
      type: 'tool_start',
      toolCallId: 'tool-protocols',
      toolName: 'load_protocols',
      submissionId: 'submission-greeting',
      eventIndex: 1,
      timestamp: '2026-07-20T19:08:05.200Z',
    }),
    streamEvent('0000000000000000_0000000000000002', {
      type: 'tool',
      toolCallId: 'tool-protocols',
      toolName: 'load_protocols',
      durationMs: 13,
      isError: false,
      result: { secret: 'PRIVATE_PROTOCOL_PAYLOAD' },
      submissionId: 'submission-greeting',
      eventIndex: 2,
      timestamp: '2026-07-20T19:08:05.300Z',
    }),
    streamEvent('0000000000000000_0000000000000003', {
      type: 'tool_start',
      toolCallId: 'tool-skill',
      toolName: 'activate_skill',
      submissionId: 'submission-greeting',
      eventIndex: 3,
      timestamp: '2026-07-20T19:08:05.400Z',
    }),
    streamEvent('0000000000000000_0000000000000004', {
      type: 'tool',
      toolCallId: 'tool-skill',
      toolName: 'activate_skill',
      durationMs: 22,
      isError: false,
      result: { text: 'PRIVATE_SKILL_BODY' },
      submissionId: 'submission-greeting',
      eventIndex: 4,
      timestamp: '2026-07-20T19:08:05.500Z',
    }),
    streamEvent('0000000000000000_0000000000000005', {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi Daniel' }],
      },
      submissionId: 'submission-greeting',
      eventIndex: 5,
      timestamp: '2026-07-20T19:08:05.600Z',
    }),
    streamEvent('0000000000000000_0000000000000006', {
      type: 'operation',
      operationId: 'op-greeting',
      operationKind: 'prompt',
      durationMs: 5877,
      isError: false,
      submissionId: 'submission-greeting',
      eventIndex: 6,
      timestamp: '2026-07-20T19:08:05.700Z',
    }),
    streamEvent('0000000000000000_0000000000000007', {
      type: 'operation_start',
      operationId: 'op-user-1',
      operationKind: 'prompt',
      submissionId: 'submission-user-1',
      eventIndex: 0,
      timestamp: '2026-07-20T19:09:00.100Z',
    }),
    streamEvent('0000000000000000_0000000000000008', {
      type: 'thinking_start',
      turnId: 'turn-user-1',
      submissionId: 'submission-user-1',
      eventIndex: 1,
      timestamp: '2026-07-20T19:09:00.200Z',
    }),
    streamEvent('0000000000000000_0000000000000009', {
      type: 'thinking_delta',
      turnId: 'turn-user-1',
      delta: 'checking the active repository context',
      submissionId: 'submission-user-1',
      eventIndex: 2,
      timestamp: '2026-07-20T19:09:00.300Z',
    }),
    streamEvent('0000000000000000_0000000000000010', {
      type: 'thinking_end',
      turnId: 'turn-user-1',
      content: 'checking the active repository context',
      submissionId: 'submission-user-1',
      eventIndex: 3,
      timestamp: '2026-07-20T19:09:00.400Z',
    }),
    streamEvent('0000000000000000_0000000000000011', {
      type: 'tool_start',
      toolCallId: 'tool-user-1',
      toolName: 'repository_status',
      submissionId: 'submission-user-1',
      eventIndex: 4,
      timestamp: '2026-07-20T19:09:00.500Z',
    }),
    streamEvent('0000000000000000_0000000000000012', {
      type: 'text_delta',
      text: 'NESTED_RAW_OUTPUT',
      parentSession: 'default',
      session: 'task:default:worker-1',
      submissionId: 'submission-user-1',
      eventIndex: 5,
      timestamp: '2026-07-20T19:09:00.600Z',
    }),
    streamEvent('0000000000000000_0000000000000013', {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'NESTED_FINAL_OUTPUT' }],
      },
      parentSession: 'default',
      session: 'task:default:worker-1',
      submissionId: 'submission-user-1',
      eventIndex: 6,
      timestamp: '2026-07-20T19:09:00.700Z',
    }),
    streamEvent('0000000000000000_0000000000000013', {
      type: 'operation_start',
      operationId: 'nested-operation',
      operationKind: 'PRIVATE_NESTED_OPERATION',
      parentSession: 'default',
      session: 'task:default:worker-1',
      submissionId: 'submission-user-1',
      eventIndex: 61,
      timestamp: '2026-07-20T19:09:00.710Z',
    }),
    streamEvent('0000000000000000_0000000000000013', {
      type: 'tool',
      toolCallId: 'nested-tool',
      toolName: 'PRIVATE_NESTED_TOOL',
      parentSession: 'default',
      session: 'task:default:worker-1',
      submissionId: 'submission-user-1',
      eventIndex: 62,
      timestamp: '2026-07-20T19:09:00.720Z',
    }),
    streamEvent('0000000000000000_0000000000000013', {
      type: 'task',
      taskId: 'nested-task',
      taskName: 'PRIVATE_NESTED_TASK',
      parentSession: 'default',
      session: 'task:default:worker-1',
      submissionId: 'submission-user-1',
      eventIndex: 63,
      timestamp: '2026-07-20T19:09:00.730Z',
    }),
    streamEvent('0000000000000000_0000000000000014', {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', name: 'repository_status' }],
      },
      submissionId: 'submission-user-1',
      eventIndex: 7,
      timestamp: '2026-07-20T19:09:00.800Z',
    }),
    streamEvent('0000000000000000_0000000000000015', {
      type: 'message_end',
      message: {
        role: 'toolResult',
        content: [{ type: 'text', text: 'PRIVATE_TOOL_RESULT_BODY' }],
      },
      submissionId: 'submission-user-1',
      eventIndex: 8,
      timestamp: '2026-07-20T19:09:00.900Z',
    }),
    streamEvent('0000000000000000_0000000000000016', {
      type: 'tool',
      toolCallId: 'tool-user-1',
      toolName: 'repository_status',
      durationMs: 31,
      isError: false,
      result: { text: 'PRIVATE_TOOL_RESULT_BODY' },
      submissionId: 'submission-user-1',
      eventIndex: 9,
      timestamp: '2026-07-20T19:09:01.000Z',
    }),
    streamEvent('0000000000000000_0000000000000017', {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'The status is ready.' }],
      },
      submissionId: 'submission-user-1',
      eventIndex: 10,
      timestamp: '2026-07-20T19:09:01.100Z',
    }),
    streamEvent('0000000000000000_0000000000000018', {
      type: 'operation',
      operationId: 'op-user-1',
      operationKind: 'prompt',
      durationMs: 12700,
      isError: false,
      submissionId: 'submission-user-1',
      eventIndex: 11,
      timestamp: '2026-07-20T19:09:01.200Z',
    }),
  ];

  const page = projectSessionTranscript({
    session: { id: 'tui-1', title: 'Transcript Test' },
    prompts,
    events,
    stream: {
      nextOffset: '0000000000000000_0000000000000018',
      upToDate: true,
    },
    page: { limit: 50, hasOlder: false },
  });

  assert.deepEqual(page.exchanges.map((exchange) => ({
    id: exchange.id,
    prompt: exchange.prompt?.visibility === 'user' ? exchange.prompt.text : undefined,
    tools: exchange.activities.filter((item) => item.kind === 'tool').map((item) => item.status),
    final: exchange.assistant?.text,
  })), [
    {
      id: 'submission-greeting',
      prompt: undefined,
      tools: ['completed', 'completed'],
      final: 'Hi Daniel',
    },
    {
      id: 'submission-user-1',
      prompt: 'Explain the status',
      tools: ['completed'],
      final: 'The status is ready.',
    },
  ]);
  assert.equal(page.exchanges[0]?.prompt, undefined);
  assert.equal(
    page.exchanges[1]?.activities.find((item) => item.kind === 'thinking')?.preview,
    'checking the active repository context',
  );
  assert.equal(
    page.exchanges[1]?.activities.find((item) => item.kind === 'operation')?.durationMs,
    12700,
  );
  const serialized = JSON.stringify(page);
  assert.doesNotMatch(serialized, /PRIVATE_|NESTED_/);
  assert.doesNotMatch(serialized, /automatic SIM-ONE Alpha local Ratatui/);
});

test('uses terminal isError and duration fields for failed activity and exchange status', () => {
  const page = projectSessionTranscript({
    session: { id: 'tui-failed' },
    prompts: [
      prompt({
        eventId: 'prompt-failed',
        text: 'Run the failing task',
        receivedAt: '2026-07-20T20:00:00.000Z',
        submissionId: 'submission-failed',
      }),
    ],
    events: [
      streamEvent('0000000000000000_0000000000000000', {
        type: 'operation_start',
        operationId: 'op-failed',
        submissionId: 'submission-failed',
        eventIndex: 0,
        timestamp: '2026-07-20T20:00:00.100Z',
      }),
      streamEvent('0000000000000000_0000000000000001', {
        type: 'tool_start',
        toolCallId: 'tool-failed',
        toolName: 'broken_tool',
        submissionId: 'submission-failed',
        eventIndex: 1,
        timestamp: '2026-07-20T20:00:00.200Z',
      }),
      streamEvent('0000000000000000_0000000000000002', {
        type: 'tool',
        toolCallId: 'tool-failed',
        toolName: 'broken_tool',
        durationMs: 17,
        isError: true,
        submissionId: 'submission-failed',
        eventIndex: 2,
        timestamp: '2026-07-20T20:00:00.300Z',
      }),
      streamEvent('0000000000000000_0000000000000003', {
        type: 'task_start',
        taskId: 'task-failed',
        taskName: 'researcher',
        submissionId: 'submission-failed',
        eventIndex: 3,
        timestamp: '2026-07-20T20:00:00.400Z',
      }),
      streamEvent('0000000000000000_0000000000000004', {
        type: 'task',
        taskId: 'task-failed',
        taskName: 'researcher',
        durationMs: 23,
        isError: true,
        submissionId: 'submission-failed',
        eventIndex: 4,
        timestamp: '2026-07-20T20:00:00.500Z',
      }),
      streamEvent('0000000000000000_0000000000000005', {
        type: 'turn',
        turnId: 'turn-failed',
        durationMs: 31,
        isError: true,
        submissionId: 'submission-failed',
        eventIndex: 5,
        timestamp: '2026-07-20T20:00:00.600Z',
      }),
      streamEvent('0000000000000000_0000000000000006', {
        type: 'operation',
        operationId: 'op-failed',
        durationMs: 42,
        isError: true,
        submissionId: 'submission-failed',
        eventIndex: 6,
        timestamp: '2026-07-20T20:00:00.700Z',
      }),
    ],
    stream: { nextOffset: '0000000000000000_0000000000000006', upToDate: true },
    page: { limit: 50, hasOlder: false },
  });

  assert.equal(page.exchanges[0]?.status, 'failed');
  assert.deepEqual(
    page.exchanges[0]?.activities
      .filter((item) => item.kind === 'tool' || item.kind === 'task' || item.kind === 'operation')
      .map((item) => [item.kind, item.status, item.durationMs]),
    [
      ['operation', 'failed', 42],
      ['tool', 'failed', 17],
      ['task', 'failed', 23],
    ],
  );
});

test('correlates legacy offsets, deduplicates replay, and leaves ambiguous prompts unmerged', () => {
  const legacyPrompt = prompt({
    eventId: 'prompt-legacy',
    text: 'Legacy prompt',
    receivedAt: '2026-07-20T21:00:00.000Z',
    legacyDeliveryId: 'http://localhost/agents/orchestrator/tui-legacy#0000000000000000_0000000000000004',
  });
  const operationStart = streamEvent('0000000000000000_0000000000000005', {
    type: 'operation_start',
    operationId: 'op-legacy',
    submissionId: 'submission-legacy',
    eventIndex: 0,
    timestamp: '2026-07-20T21:00:00.100Z',
  });
  const running = projectSessionTranscript({
    session: { id: 'tui-legacy' },
    prompts: [legacyPrompt],
    events: [operationStart, operationStart],
    stream: { nextOffset: '0000000000000000_0000000000000005', upToDate: true },
    page: { limit: 50, hasOlder: false },
  });

  assert.equal(running.exchanges.length, 1);
  assert.equal(running.exchanges[0]?.id, 'submission-legacy');
  assert.equal(running.exchanges[0]?.prompt?.text, 'Legacy prompt');
  assert.equal(running.exchanges[0]?.status, 'running');
  assert.equal(running.exchanges[0]?.activities.length, 1);

  const ambiguous = projectSessionTranscript({
    session: { id: 'tui-ambiguous' },
    prompts: [
      prompt({
        eventId: 'prompt-ambiguous',
        text: 'Do not guess',
        receivedAt: '2026-07-20T22:00:00.000Z',
      }),
    ],
    events: [
      streamEvent('0000000000000000_0000000000000000', {
        type: 'operation_start',
        operationId: 'op-a',
        submissionId: 'submission-a',
        eventIndex: 0,
        timestamp: '2026-07-20T22:00:00.100Z',
      }),
      streamEvent('0000000000000000_0000000000000001', {
        type: 'operation_start',
        operationId: 'op-b',
        submissionId: 'submission-b',
        eventIndex: 0,
        timestamp: '2026-07-20T22:00:00.200Z',
      }),
    ],
    stream: { nextOffset: '0000000000000000_0000000000000001', upToDate: true },
    page: { limit: 50, hasOlder: false },
  });

  assert.equal(ambiguous.exchanges.some((exchange) =>
    exchange.prompt?.text === 'Do not guess' && exchange.submissionId.startsWith('prompt:')), true);
  assert.equal(ambiguous.exchanges.some((exchange) =>
    exchange.prompt?.text === 'Do not guess' && exchange.submissionId.startsWith('submission-')), false);
  assert.deepEqual(
    ambiguous.exchanges.filter((exchange) => !exchange.prompt).map((exchange) => exchange.id),
    ['submission-a', 'submission-b'],
  );
});

test('correlates durable stream events that omit submission ids', () => {
  const page = projectSessionTranscript({
    session: { id: 'tui-missing-submission' },
    prompts: [
      prompt({
        eventId: 'prompt-missing-submission',
        text: 'Restore this response',
        receivedAt: '2026-07-20T22:05:00.000Z',
        offset: '0000000000000000_0000000000000001',
      }),
    ],
    events: [
      streamEvent('0000000000000000_0000000000000002', {
        type: 'turn_start',
        eventIndex: 0,
        timestamp: '2026-07-20T22:05:00.100Z',
      }),
      streamEvent('0000000000000000_0000000000000003', {
        type: 'operation_start',
        operationId: 'operation-missing-submission',
        eventIndex: 1,
        timestamp: '2026-07-20T22:05:00.200Z',
      }),
      streamEvent('0000000000000000_0000000000000004', {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Restored assistant response' }],
        },
        eventIndex: 2,
        timestamp: '2026-07-20T22:05:00.300Z',
      }),
      streamEvent('0000000000000000_0000000000000005', {
        type: 'operation',
        operationId: 'operation-missing-submission',
        eventIndex: 3,
        timestamp: '2026-07-20T22:05:00.400Z',
      }),
    ],
    stream: { nextOffset: '0000000000000000_0000000000000005', upToDate: true },
    page: { limit: 50, hasOlder: false },
  });

  assert.equal(page.exchanges.length, 1);
  assert.equal(page.exchanges[0]?.prompt?.text, 'Restore this response');
  assert.equal(page.exchanges[0]?.assistant?.text, 'Restored assistant response');
  assert.equal(page.exchanges[0]?.status, 'completed');
});

test('omits undelivered pre-LLM commands while preserving unmatched user prompts', () => {
  const page = projectSessionTranscript({
    session: { id: 'tui-command-history' },
    prompts: [
      prompt({
        eventId: 'prompt-user-unmatched',
        text: 'Keep this unmatched prompt',
        receivedAt: '2026-07-20T22:10:00.000Z',
      }),
      prompt({
        eventId: 'prompt-delivered-slash-text',
        text: '/rename this text reached Flue',
        receivedAt: '2026-07-20T22:10:30.000Z',
        submissionId: 'submission-delivered-slash-text',
      }),
      ...[
        '/new Transcript Test',
        '/clear Transcript Test',
        '/resume Transcript Test',
        '/rename Transcript Test',
        '/compact',
        '/session',
      ].map((text, index) => prompt({
        eventId: `prompt-command-${index}`,
        text,
        receivedAt: `2026-07-20T22:${String(index + 11).padStart(2, '0')}:00.000Z`,
      })),
    ],
    events: [],
    stream: { nextOffset: '-1', upToDate: true },
    page: { limit: 50, hasOlder: false },
  });

  assert.deepEqual(
    page.exchanges.map((exchange) => exchange.prompt?.text),
    ['Keep this unmatched prompt', '/rename this text reached Flue'],
  );
});

test('round-trips opaque transcript cursors and rejects malformed values', () => {
  const cursor = encodeTranscriptCursor({
    v: 1,
    receivedAt: '2026-07-20T21:00:00.000Z',
    eventId: 'prompt-42',
  });

  assert.deepEqual(decodeTranscriptCursor(cursor), {
    v: 1,
    receivedAt: '2026-07-20T21:00:00.000Z',
    eventId: 'prompt-42',
  });
  assert.throws(() => decodeTranscriptCursor('not-base64-json'), /cursor/i);
  assert.throws(
    () => decodeTranscriptCursor(
      Buffer.from(JSON.stringify({ v: 2, receivedAt: 'nope', eventId: '' })).toString('base64url'),
    ),
    /cursor/i,
  );
});

test('loads transcript pages from bounded event-store reads without page overlap', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gorombo-transcript-page-'));
  const database = new GoromboSessionDatabase(join(directory, 'sessions.sqlite'));
  const entries = [
    streamEvent('0000000000000000_0000000000000000', {
      type: 'operation_start',
      operationId: 'op-1',
      submissionId: 'submission-1',
      eventIndex: 0,
      timestamp: '2026-07-20T23:00:00.100Z',
    }),
    streamEvent('0000000000000000_0000000000000001', {
      type: 'operation_start',
      operationId: 'op-2',
      submissionId: 'submission-2',
      eventIndex: 0,
      timestamp: '2026-07-20T23:01:00.100Z',
    }),
    streamEvent('0000000000000000_0000000000000002', {
      type: 'operation_start',
      operationId: 'op-3',
      submissionId: 'submission-3',
      eventIndex: 0,
      timestamp: '2026-07-20T23:02:00.100Z',
    }),
  ];
  const reads: string[] = [];
  const store: EventStreamStore = {
    async createStream() {},
    async appendEvent() {
      throw new Error('append is not used by transcript reads');
    },
    async readEvents(path, options) {
      assert.equal(path, 'agents/orchestrator/tui-paged');
      const offset = options?.offset ?? '-1';
      reads.push(offset);
      const remaining = entries.filter((entry) =>
        parseOffset(entry.offset) > parseOffset(offset));
      const batch = remaining.slice(0, 1);
      return {
        events: batch,
        nextOffset: batch.at(-1)?.offset ?? offset,
        upToDate: batch.length === remaining.length,
        closed: false,
      };
    },
    async closeStream() {},
    async getStreamMeta() {
      return {
        nextOffset: '0000000000000000_0000000000000002',
        closed: false,
      };
    },
    subscribe() {
      return () => {};
    },
  };

  try {
    for (const [index, offset] of [
      ['1', '-1'],
      ['2', '0000000000000000_0000000000000000'],
      ['3', '0000000000000000_0000000000000001'],
    ] as const) {
      const record = prompt({
        eventId: `prompt-${index}`,
        text: `Prompt ${index}`,
        receivedAt: `2026-07-20T23:0${Number(index) - 1}:00.000Z`,
        submissionId: `submission-${index}`,
      });
      database.recordNormalizedMessageEvent({
        event: record.event,
        sessionId: 'tui-paged',
        deliveryKind: 'direct-agent',
        deliveryId: `submission-${index}`,
        delivery: {
          submissionId: `submission-${index}`,
          streamUrl: '/agents/orchestrator/tui-paged',
          offset,
        },
      });
    }
    database.recordNormalizedMessageEvent({
      event: {
        id: 'local-command',
        connector: 'tui',
        kind: 'chat.message',
        text: '/session',
        receivedAt: '2026-07-20T23:03:00.000Z',
        actor: { id: 'local-tui' },
        conversation: { id: 'local-tui', threadId: 'local-tui' },
      },
      sessionId: 'tui-paged',
      deliveryKind: 'session-command',
    });

    const newest = await loadSessionTranscriptPage({
      session: { id: 'tui-paged', title: 'Paged Session' },
      sessionDatabase: database,
      eventStreamStore: store,
      limit: 2,
    });
    assert.deepEqual(newest.exchanges.map((exchange) => exchange.id), [
      'submission-2',
      'submission-3',
    ]);
    assert.equal(newest.page.hasOlder, true);
    assert.equal(typeof newest.page.before, 'string');
    assert.deepEqual(reads, [
      '-1',
      '0000000000000000_0000000000000000',
      '0000000000000000_0000000000000001',
    ]);

    reads.length = 0;
    const older = await loadSessionTranscriptPage({
      session: { id: 'tui-paged', title: 'Paged Session' },
      sessionDatabase: database,
      eventStreamStore: store,
      limit: 2,
      before: newest.page.before,
    });
    assert.deepEqual(older.exchanges.map((exchange) => exchange.id), ['submission-1']);
    assert.equal(older.page.hasOlder, false);
    assert.equal(older.page.before, undefined);
    assert.equal(
      older.exchanges.some((exchange) => newest.exchanges.some((item) => item.id === exchange.id)),
      false,
    );
    assert.deepEqual(reads, [
      '-1',
      '0000000000000000_0000000000000000',
      '0000000000000000_0000000000000001',
    ]);

    const otherSession = prompt({
      eventId: 'prompt-other-session',
      text: 'Other session prompt',
      receivedAt: '2026-07-20T23:04:00.000Z',
      submissionId: 'submission-other-session',
    });
    database.recordNormalizedMessageEvent({
      event: otherSession.event,
      sessionId: 'tui-other',
      deliveryKind: 'direct-agent',
      delivery: {
        submissionId: 'submission-other-session',
        offset: '0000000000000000_0000000000000002',
      },
    });
    const foreignCursor = encodeTranscriptCursor({
      v: 1,
      receivedAt: otherSession.event.receivedAt,
      eventId: otherSession.event.id,
    });
    await assert.rejects(
      loadSessionTranscriptPage({
        session: { id: 'tui-paged' },
        sessionDatabase: database,
        eventStreamStore: store,
        limit: 2,
        before: foreignCursor,
      }),
      /cursor/i,
    );
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('older transcript pages retain replies that complete after a newer prompt starts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gorombo-transcript-overlap-'));
  const database = new GoromboSessionDatabase(join(directory, 'sessions.sqlite'));
  const sessionId = 'tui-overlapping-prompts';
  const entries = [
    streamEvent('0000000000000000_0000000000000000', {
      type: 'operation_start',
      operationId: 'op-first',
      submissionId: 'submission-first',
      eventIndex: 0,
      timestamp: '2026-07-21T00:00:00.100Z',
    }),
    streamEvent('0000000000000000_0000000000000001', {
      type: 'operation_start',
      operationId: 'op-second',
      submissionId: 'submission-second',
      eventIndex: 0,
      timestamp: '2026-07-21T00:00:01.100Z',
    }),
    streamEvent('0000000000000000_0000000000000002', {
      type: 'message_end',
      submissionId: 'submission-first',
      eventIndex: 1,
      timestamp: '2026-07-21T00:00:02.100Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'First response completed late' }],
      },
    }),
    streamEvent('0000000000000000_0000000000000003', {
      type: 'operation',
      operationId: 'op-first',
      submissionId: 'submission-first',
      eventIndex: 2,
      timestamp: '2026-07-21T00:00:02.200Z',
    }),
  ];

  try {
    recordTranscriptPrompt(database, sessionId, prompt({
      eventId: 'prompt-first',
      text: 'First prompt',
      receivedAt: '2026-07-21T00:00:00.000Z',
      submissionId: 'submission-first',
      offset: '-1',
    }));
    recordTranscriptPrompt(database, sessionId, prompt({
      eventId: 'prompt-second',
      text: 'Second prompt',
      receivedAt: '2026-07-21T00:00:01.000Z',
      submissionId: 'submission-second',
      offset: '0000000000000000_0000000000000000',
    }));
    const store = eventStoreFor(`agents/orchestrator/${sessionId}`, entries);

    const newest = await loadSessionTranscriptPage({
      session: { id: sessionId },
      sessionDatabase: database,
      eventStreamStore: store,
      limit: 1,
    });
    const older = await loadSessionTranscriptPage({
      session: { id: sessionId },
      sessionDatabase: database,
      eventStreamStore: store,
      limit: 1,
      before: newest.page.before,
    });

    assert.equal(older.exchanges[0]?.prompt?.text, 'First prompt');
    assert.equal(older.exchanges[0]?.assistant?.text, 'First response completed late');
    assert.equal(older.exchanges[0]?.status, 'completed');
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('transcript pagination fills pages past hidden internal prompt rows', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gorombo-transcript-hidden-'));
  const database = new GoromboSessionDatabase(join(directory, 'sessions.sqlite'));
  const sessionId = 'tui-hidden-page-boundary';
  const entries = [
    streamEvent('0000000000000000_0000000000000000', {
      type: 'message_end',
      submissionId: 'submission-visible-old',
      eventIndex: 0,
      timestamp: '2026-07-21T01:00:00.100Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Visible old response' }],
      },
    }),
    streamEvent('0000000000000000_0000000000000001', {
      type: 'message_end',
      submissionId: 'submission-visible-new',
      eventIndex: 0,
      timestamp: '2026-07-21T01:00:02.100Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Visible new response' }],
      },
    }),
  ];

  try {
    recordTranscriptPrompt(database, sessionId, prompt({
      eventId: 'prompt-visible-old',
      text: 'Visible old prompt',
      receivedAt: '2026-07-21T01:00:00.000Z',
      submissionId: 'submission-visible-old',
      offset: '-1',
    }));
    recordTranscriptPrompt(database, sessionId, prompt({
      eventId: 'prompt-hidden',
      text: 'INTERNAL_STARTUP_SENTINEL',
      receivedAt: '2026-07-21T01:00:01.000Z',
      submissionId: 'submission-hidden',
      offset: '0000000000000000_0000000000000000',
      workflow: 'tui.startup-preflight',
    }));
    recordTranscriptPrompt(database, sessionId, prompt({
      eventId: 'prompt-visible-new',
      text: 'Visible new prompt',
      receivedAt: '2026-07-21T01:00:02.000Z',
      submissionId: 'submission-visible-new',
      offset: '0000000000000000_0000000000000000',
    }));
    const store = eventStoreFor(`agents/orchestrator/${sessionId}`, entries);

    const newest = await loadSessionTranscriptPage({
      session: { id: sessionId },
      sessionDatabase: database,
      eventStreamStore: store,
      limit: 1,
    });
    const older = await loadSessionTranscriptPage({
      session: { id: sessionId },
      sessionDatabase: database,
      eventStreamStore: store,
      limit: 1,
      before: newest.page.before,
    });

    assert.deepEqual(
      older.exchanges.map((exchange) => exchange.prompt?.text),
      ['Visible old prompt'],
    );
    assert.equal(older.page.hasOlder, false);
    assert.equal(older.page.before, undefined);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function prompt(input: {
  eventId: string;
  text: string;
  receivedAt: string;
  submissionId?: string;
  offset?: string;
  workflow?: string;
  legacyDeliveryId?: string;
}): SessionNormalizedMessageRecord {
  return {
    sessionId: 'tui-1',
    event: {
      id: input.eventId,
      connector: 'tui',
      kind: 'chat.message',
      text: input.text,
      receivedAt: input.receivedAt,
      actor: { id: 'local-tui' },
      conversation: { id: 'local-tui', threadId: 'local-tui' },
      ...(input.workflow ? { context: { workflow: input.workflow } } : {}),
    },
    delivery: {
      ...(input.submissionId ? { submissionId: input.submissionId } : {}),
      ...(input.offset ? { offset: input.offset } : {}),
    },
    ...(input.legacyDeliveryId ? { legacyDeliveryId: input.legacyDeliveryId } : {}),
  };
}

function streamEvent(offset: string, data: Record<string, unknown>) {
  return { offset, data };
}

function recordTranscriptPrompt(
  database: GoromboSessionDatabase,
  sessionId: string,
  record: SessionNormalizedMessageRecord,
): void {
  database.recordNormalizedMessageEvent({
    event: record.event,
    sessionId,
    deliveryKind: 'direct-agent',
    deliveryId: record.delivery.submissionId,
    delivery: record.delivery,
  });
}

function eventStoreFor(
  expectedPath: string,
  entries: ReturnType<typeof streamEvent>[],
): EventStreamStore {
  return {
    async createStream() {},
    async appendEvent() {
      throw new Error('append is not used by transcript reads');
    },
    async readEvents(path, options) {
      assert.equal(path, expectedPath);
      const offset = options?.offset ?? '-1';
      const remaining = entries.filter((entry) =>
        parseOffset(entry.offset) > parseOffset(offset));
      const batch = remaining.slice(0, options?.limit ?? remaining.length);
      return {
        events: batch,
        nextOffset: batch.at(-1)?.offset ?? offset,
        upToDate: batch.length === remaining.length,
        closed: false,
      };
    },
    async closeStream() {},
    async getStreamMeta() {
      return {
        nextOffset: entries.at(-1)?.offset ?? '-1',
        closed: false,
      };
    },
    subscribe() {
      return () => {};
    },
  };
}
