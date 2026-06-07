import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateContextBudget } from '../session/context-budget.js';

test('context budget reserves output tokens from provider-safe context', () => {
  const budget = calculateContextBudget({
    contextWindow: 1_000_000,
    providerReportedContextWindow: 524_288,
    maxOutputTokens: 131_072,
  });

  assert.equal(budget.enforcedContextWindow, 524_288);
  assert.equal(budget.outputReserveTokens, 131_072);
  assert.equal(budget.usableInputTokens, 393_216);
});

test('context budget caps oversized output windows to keep usable input budget', () => {
  const budget = calculateContextBudget({
    contextWindow: 1_048_576,
    providerReportedContextWindow: 1_048_576,
    maxOutputTokens: 1_048_576,
  });

  assert.equal(budget.outputReserveTokens, 262_144);
  assert.equal(budget.usableInputTokens, 786_432);
});

test('context budget exposes warning and compaction thresholds', () => {
  const budget = calculateContextBudget({
    contextWindow: 262_144,
    maxOutputTokens: 65_536,
    warningRatio: 0.7,
    compactionRatio: 0.85,
  });

  assert.equal(budget.usableInputTokens, 196_608);
  assert.equal(budget.warningTokens, 137_625);
  assert.equal(budget.compactionTokens, 167_116);
});
