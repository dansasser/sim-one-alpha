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
  assert.equal(page.exchanges[0]?.prompt?.visibility, 'internal');
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
    },
    ...(input.legacyDeliveryId ? { legacyDeliveryId: input.legacyDeliveryId } : {}),
  };
}

function streamEvent(offset: string, data: Record<string, unknown>) {
  return { offset, data };
}
