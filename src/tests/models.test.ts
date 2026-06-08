import assert from 'node:assert/strict';
import test from 'node:test';
import { codexBrainCard, deepseekV4ProCard, minimaxM3Card, qwen35Card, resolveModelCard } from '../models/catalog.js';
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
  assert.deepEqual(minimaxM3Card.env?.apiKey, ['OLLAMA_API_KEY', 'OLLAMA_CLOUD_API_KEY']);
  assert.equal(minimaxM3Card.env?.baseUrl, 'OLLAMA_CLOUD_BASE_URL');
  assert.equal(minimaxM3Card.contextWindow, 1_000_000);
  assert.equal(minimaxM3Card.guaranteedContextWindow, 512_000);
  assert.equal(minimaxM3Card.providerReportedContextWindow, 524_288);
  assert.equal(minimaxM3Card.maxOutputTokens, 131_072);
});

test('latest DeepSeek card tracks cloud context limits', () => {
  assert.equal(deepseekV4ProCard.specifier, 'ollama-cloud/deepseek-v4-pro');
  assert.deepEqual(deepseekV4ProCard.env?.apiKey, ['OLLAMA_API_KEY', 'OLLAMA_CLOUD_API_KEY']);
  assert.equal(deepseekV4ProCard.contextWindow, 1_048_576);
  assert.equal(deepseekV4ProCard.maxOutputTokens, 1_048_576);
});

test('Qwen 3.5 card tracks cloud context limits', () => {
  assert.equal(qwen35Card.specifier, 'ollama-cloud/qwen3.5:397b');
  assert.deepEqual(qwen35Card.env?.apiKey, ['OLLAMA_API_KEY', 'OLLAMA_CLOUD_API_KEY']);
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

test('model registry includes Codex Brain as a separate non-Ollama provider profile', () => {
  const registry = createModelRegistry({
    OLLAMA_API_KEY: 'test-key',
  });

  assert.equal(registry.byKey.get('codex-brain')?.specifier, 'codex-brain/gpt-5.5');
  assert.equal(codexBrainCard.providerId, 'codex-brain');
  assert.equal(codexBrainCard.modelId, 'gpt-5.5');
  assert.equal(codexBrainCard.env?.apiKey, 'CODEX_BRAIN_LOCAL_API_KEY');
  assert.equal(codexBrainCard.env?.baseUrl, 'CODEX_BRAIN_LOCAL_API_URL');
  assert.match(codexBrainCard.source?.notes ?? '', /\/v1\/models returns gpt-5\.5/);
  assert.match(codexBrainCard.source?.notes ?? '', /\/v1\/chat\/completions/);
  assert.doesNotMatch(codexBrainCard.source?.notes ?? '', /Override this card|DT1 exposes|metadata is confirmed/);
});

test('runtime config requires an API key for Ollama Cloud profiles', () => {
  assert.throws(() => configureRuntimeModels({}), /OLLAMA_API_KEY or OLLAMA_CLOUD_API_KEY is required/);
});

test('runtime config requires Codex Brain endpoint values when Codex Brain is selected', () => {
  assert.throws(
    () =>
      configureRuntimeModels({
        OLLAMA_API_KEY: 'test-key',
        GOROMBO_MODEL_PROFILE: 'codex-brain',
      }),
    /CODEX_BRAIN_LOCAL_API_KEY and CODEX_BRAIN_LOCAL_API_URL are required/,
  );

  const registry = configureRuntimeModels({
    OLLAMA_API_KEY: 'test-key',
    GOROMBO_MODEL_PROFILE: 'codex-brain',
    CODEX_BRAIN_LOCAL_API_KEY: 'test-key',
    CODEX_BRAIN_LOCAL_API_URL: 'https://dt1.example.test/v1',
  });

  assert.equal(registry.defaultAgentModel, 'codex-brain/gpt-5.5');
});

test('model cards can be resolved from Flue specifier', () => {
  assert.equal(resolveModelCard('ollama-cloud/minimax-m3')?.key, 'minimax-m3-cloud');
  assert.equal(resolveModelCard('ollama-cloud/deepseek-v4-pro')?.key, 'deepseek-v4-pro-cloud');
  assert.equal(resolveModelCard('ollama-cloud/qwen3.5:397b')?.key, 'qwen3-5-cloud');
  assert.equal(resolveModelCard('codex-brain/gpt-5.5')?.key, 'codex-brain');
});

test('unknown model specifier returns undefined', () => {
  assert.equal(resolveModelCard('unknown/model'), undefined);
});
