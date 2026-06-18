import assert from 'node:assert/strict';
import test from 'node:test';

import { readMemoryEnvOverrides, resolveMemoryConfig } from '../memory/structured-memory-runtime.js';

test('resolveMemoryConfig applies defaults when the block is absent', () => {
  const cfg = resolveMemoryConfig(undefined, {});
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.backend, 'sqlite');
  assert.equal(cfg.retentionDays, 30);
  assert.equal(cfg.maxChecklistDepth, 5);
  assert.equal(cfg.enableSemanticNotes, true);
});

test('resolveMemoryConfig reads numeric/boolean fields from the JSON block', () => {
  const cfg = resolveMemoryConfig(
    { retentionDays: 7, maxChecklistDepth: 3, enableSemanticNotes: false, backend: 'memory' },
    {},
  );
  assert.equal(cfg.retentionDays, 7);
  assert.equal(cfg.maxChecklistDepth, 3);
  assert.equal(cfg.enableSemanticNotes, false);
  assert.equal(cfg.backend, 'memory');
});

test('GOROMBO_MEMORY_* env vars override the JSON config', () => {
  const cfg = resolveMemoryConfig(
    { retentionDays: 7, defaultLimit: 5 },
    {
      GOROMBO_MEMORY_RETENTION_DAYS: '1',
      GOROMBO_MEMORY_DEFAULT_LIMIT: '99',
      GOROMBO_MEMORY_BACKEND: 'memory',
      GOROMBO_MEMORY_SQLITE_PATH: '/tmp/x.sqlite',
      GOROMBO_MEMORY_MAX_CHECKLIST_DEPTH: '8',
    },
  );
  assert.equal(cfg.retentionDays, 1, 'env overrides json');
  assert.equal(cfg.defaultLimit, 99);
  assert.equal(cfg.backend, 'memory');
  assert.equal(cfg.sqlitePath, '/tmp/x.sqlite');
  assert.equal(cfg.maxChecklistDepth, 8);
  // JSON-only field not overridden by env stays from json.
  assert.equal(cfg.maxContextTokens, 1500);
});

test('readMemoryEnvOverrides ignores malformed numbers and unknown backends', () => {
  const out = readMemoryEnvOverrides({
    GOROMBO_MEMORY_RETENTION_DAYS: 'not-a-number',
    GOROMBO_MEMORY_BACKEND: 'redis',
    GOROMBO_MEMORY_MAX_CONTEXT_TOKENS: '2048',
  });
  assert.equal('retentionDays' in out, false);
  assert.equal('backend' in out, false);
  assert.equal(out.maxContextTokens, 2048);
});
