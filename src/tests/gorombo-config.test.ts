import assert from 'node:assert/strict';
import test from 'node:test';
import { loadGoromboConfig, validateGoromboConfig } from '../config/index.js';

test('GOROMBO config loads model card keys from the shipped runtime config file', () => {
  const config = loadGoromboConfig();

  assert.equal(config.models.primary, 'minimax-m3-cloud');
  assert.equal(config.models.backup, 'codex-brain');
});

test('GOROMBO config validates the main model config shape', () => {
  assert.throws(() => validateGoromboConfig({}, 'test config'), /must declare "version": 1/);
  assert.throws(
    () =>
      validateGoromboConfig({
        version: 1,
        models: {},
      }, 'test config'),
    /models.primary as a model card key/,
  );
});
