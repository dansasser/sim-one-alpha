import assert from 'node:assert/strict';
import test from 'node:test';
import { configureRuntimeModels, createModelRegistry, selectModelForRole } from '../models/index.js';

test('model registry defaults agentic chat to MiniMax M3', () => {
  const registry = createModelRegistry({
    OLLAMA_API_KEY: 'test-key',
  });

  assert.equal(registry.defaultAgentModel, 'ollama-cloud/minimax-m3');
  assert.equal(selectModelForRole(registry, 'agentic-chat'), 'ollama-cloud/minimax-m3');
});

test('model registry can select DeepSeek profile by key', () => {
  const registry = createModelRegistry({
    OLLAMA_API_KEY: 'test-key',
    GOROMBO_MODEL_PROFILE: 'deepseek-v4-pro-cloud',
  });

  assert.equal(registry.defaultAgentModel, 'ollama-cloud/deepseek-v4-pro');
});

test('explicit GOROMBO_MODEL overrides named model profiles', () => {
  const registry = createModelRegistry({
    OLLAMA_API_KEY: 'test-key',
    GOROMBO_MODEL_PROFILE: 'minimax-m3-cloud',
    GOROMBO_MODEL: 'openrouter/example-agent-model',
  });

  assert.equal(registry.defaultAgentModel, 'openrouter/example-agent-model');
});

test('model registry includes optional local Codex Brain profile when configured', () => {
  const registry = createModelRegistry({
    OLLAMA_API_KEY: 'test-key',
    OLLAMA_CODEX_BRAIN_MODEL: 'codex-brain:latest',
  });

  assert.equal(registry.byKey.get('codex-brain')?.specifier, 'ollama-local/codex-brain:latest');
});

test('runtime config requires an API key for Ollama Cloud profiles', () => {
  assert.throws(() => configureRuntimeModels({}), /OLLAMA_API_KEY is required/);
});
