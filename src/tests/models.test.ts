import assert from 'node:assert/strict';
import test from 'node:test';
import { deepseekV4ProCard, minimaxM3Card, qwen35Card } from '../models/cards/index.js';
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

test('MiniMax M3 card tracks advertised and operational context limits', () => {
  assert.equal(minimaxM3Card.specifier, 'ollama-cloud/minimax-m3');
  assert.equal(minimaxM3Card.contextWindow, 1_000_000);
  assert.equal(minimaxM3Card.guaranteedContextWindow, 512_000);
  assert.equal(minimaxM3Card.providerReportedContextWindow, 524_288);
  assert.equal(minimaxM3Card.maxOutputTokens, 131_072);
});

test('latest DeepSeek card tracks cloud context limits', () => {
  assert.equal(deepseekV4ProCard.specifier, 'ollama-cloud/deepseek-v4-pro');
  assert.equal(deepseekV4ProCard.contextWindow, 1_048_576);
  assert.equal(deepseekV4ProCard.maxOutputTokens, 1_048_576);
});

test('Qwen 3.5 card tracks cloud context limits', () => {
  assert.equal(qwen35Card.specifier, 'ollama-cloud/qwen3.5:397b');
  assert.equal(qwen35Card.contextWindow, 262_144);
  assert.equal(qwen35Card.maxOutputTokens, 65_536);
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
  assert.throws(() => configureRuntimeModels({}), /OLLAMA_API_KEY or OLLAMA_CLOUD_API_KEY is required/);
});
