import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateCompaction } from '../session/compaction-policy.js';

test('compaction policy stays normal below warning threshold', () => {
  assert.equal(
    evaluateCompaction({ usedTokens: 100, warningTokens: 200, compactionTokens: 300, hardStopTokens: 400 }).status,
    'normal',
  );
});

test('compaction policy warns before compaction threshold', () => {
  assert.equal(
    evaluateCompaction({ usedTokens: 250, warningTokens: 200, compactionTokens: 300, hardStopTokens: 400 }).status,
    'warn',
  );
});

test('compaction policy requests compaction at threshold', () => {
  assert.equal(
    evaluateCompaction({ usedTokens: 300, warningTokens: 200, compactionTokens: 300, hardStopTokens: 400 }).status,
    'compact',
  );
});

test('compaction policy stops when the hard budget is exceeded', () => {
  assert.equal(
    evaluateCompaction({ usedTokens: 401, warningTokens: 200, compactionTokens: 300, hardStopTokens: 400 }).status,
    'stop',
  );
});
