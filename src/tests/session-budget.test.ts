import assert from 'node:assert/strict';
import test from 'node:test';
import { minimaxM3Card } from '../models/cards/index.js';
import { calculateContextBudget } from '../session/context-budget.js';
import {
  InMemorySessionBudgetStore,
  createSessionBudgetReport,
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
