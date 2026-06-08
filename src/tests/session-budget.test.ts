import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionData } from '@flue/runtime';
import { minimaxM3Card } from '../models/cards/index.js';
import { calculateContextBudget } from '../session/context-budget.js';
import {
  InMemorySessionBudgetStore,
  createSessionBudgetReport,
  deriveSessionBudgetStateFromData,
  recordManualCompaction,
  recordPromptUsage,
} from '../session/session-budget.js';

test('session budget report requests compaction before an oversized next prompt', () => {
  const store = new InMemorySessionBudgetStore();
  const budget = calculateContextBudget(minimaxM3Card);

  store.setForTest({
    sessionId: 'support',
    modelSpecifier: minimaxM3Card.specifier,
    estimatedHistoryTokens: budget.compactionTokens - 10,
    turns: 3,
    compactions: 0,
  });

  const report = createSessionBudgetReport({
    sessionId: 'support',
    modelCard: minimaxM3Card,
    promptText: 'x'.repeat(100),
    store,
  });

  assert.equal(report.status, 'compact');
  assert.equal(report.shouldCompactBeforePrompt, true);
});

test('session budget usage recording tracks provider usage for later turns', () => {
  const store = new InMemorySessionBudgetStore();

  recordPromptUsage({
    sessionId: 'support',
    modelSpecifier: minimaxM3Card.specifier,
    promptEstimateTokens: 100,
    usage: {
      input: 1_000,
      output: 200,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1_200,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    store,
  });

  const state = store.get('support', minimaxM3Card.specifier);

  assert.equal(state.estimatedHistoryTokens, 1_200);
  assert.equal(state.turns, 1);
});

test('manual compaction reduces the local history estimate', () => {
  const store = new InMemorySessionBudgetStore();
  const budget = calculateContextBudget(minimaxM3Card);

  store.setForTest({
    sessionId: 'support',
    modelSpecifier: minimaxM3Card.specifier,
    estimatedHistoryTokens: budget.compactionTokens + 1_000,
    turns: 3,
    compactions: 0,
  });

  recordManualCompaction({
    sessionId: 'support',
    modelSpecifier: minimaxM3Card.specifier,
    budget,
    store,
  });

  const state = store.get('support', minimaxM3Card.specifier);

  assert.ok(state.estimatedHistoryTokens < budget.compactionTokens);
  assert.equal(state.compactions, 1);
});

test('session budget can be derived from stored Flue session data', () => {
  const report = createSessionBudgetReport({
    sessionId: 'support',
    modelCard: minimaxM3Card,
    promptText: 'What did I ask before?',
    sessionData: createSessionDataWithUsage(),
  });

  assert.equal(report.estimatedHistoryTokens, 1_200);
  assert.equal(report.turns, 1);
  assert.equal(report.compactions, 0);
  assert.equal(report.estimatedPromptTokens, 6);
  assert.equal(report.estimatedUsedTokens, 1_206);
});

test('session budget derivation treats latest compaction as the active context boundary', () => {
  const state = deriveSessionBudgetStateFromData({
    sessionId: 'support',
    modelSpecifier: minimaxM3Card.specifier,
    data: createCompactedSessionData(),
  });

  assert.equal(state.turns, 1);
  assert.equal(state.compactions, 1);
  assert.ok(state.estimatedHistoryTokens < 1_000);
});

function createSessionDataWithUsage(): SessionData {
  return {
    version: 4,
    entries: [
      {
        type: 'message',
        id: 'user-1',
        parentId: null,
        timestamp: '2026-06-07T00:00:00.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'What is the budget?' }],
        },
        source: 'prompt',
      },
      {
        type: 'message',
        id: 'assistant-1',
        parentId: 'user-1',
        timestamp: '2026-06-07T00:00:01.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'The budget is available.' }],
          stopReason: 'stop',
          usage: {
            input: 1_000,
            output: 200,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 1_200,
          },
        },
        source: 'prompt',
      },
    ],
    leafId: 'assistant-1',
    metadata: {},
    createdAt: '2026-06-07T00:00:00.000Z',
    updatedAt: '2026-06-07T00:00:01.000Z',
  } as SessionData;
}

function createCompactedSessionData(): SessionData {
  return {
    version: 4,
    entries: [
      {
        type: 'message',
        id: 'user-1',
        parentId: null,
        timestamp: '2026-06-07T00:00:00.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Older message that was summarized.' }],
        },
        source: 'prompt',
      },
      {
        type: 'message',
        id: 'assistant-1',
        parentId: 'user-1',
        timestamp: '2026-06-07T00:00:01.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Older answer.' }],
          stopReason: 'stop',
          usage: {
            input: 200_000,
            output: 1_000,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 201_000,
          },
        },
        source: 'prompt',
      },
      {
        type: 'compaction',
        id: 'compact-1',
        parentId: 'assistant-1',
        timestamp: '2026-06-07T00:00:02.000Z',
        summary: '[Context Summary]\n\nOlder work was summarized.',
        firstKeptEntryId: 'assistant-1',
        tokensBefore: 201_000,
      },
      {
        type: 'message',
        id: 'user-2',
        parentId: 'compact-1',
        timestamp: '2026-06-07T00:00:03.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Continue.' }],
        },
        source: 'prompt',
      },
    ],
    leafId: 'user-2',
    metadata: {},
    createdAt: '2026-06-07T00:00:00.000Z',
    updatedAt: '2026-06-07T00:00:03.000Z',
  } as SessionData;
}
