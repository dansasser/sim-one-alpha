import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Bash,
  InMemoryFs,
  bashFactoryToSessionEnv,
  createFlueContext,
  resolveModel,
} from '@flue/runtime/internal';

test('durable orchestrator session required Flue internal exports are available', () => {
  assert.equal(typeof Bash, 'function');
  assert.equal(typeof InMemoryFs, 'function');
  assert.equal(typeof bashFactoryToSessionEnv, 'function');
  assert.equal(typeof createFlueContext, 'function');
  assert.equal(typeof resolveModel, 'function');
});
