import assert from 'node:assert/strict';
import test from 'node:test';
import type { PromptResponse } from '@flue/runtime';
import { normalizeWebApiMessage } from '../connectors/web-api.js';
import {
  createChatPrompt,
  createContextBudgetReport,
  isRecoverableModelFailure,
  run,
} from '../workflows/chat.js';

test('chat workflow prompt requires minimal tool flow before answering', () => {
  const event = normalizeWebApiMessage({
    text: 'What can you do?',
    actorId: 'local-user',
    conversationId: 'local-thread',
  });

  const prompt = createChatPrompt(event);

  assert.match(prompt, /load_protocols/);
  assert.doesNotMatch(prompt, /Use retrieve_context/);
  assert.match(prompt, /Do not perform web search directly/);
  assert.match(prompt, /agent: "researcher"/);
  assert.match(prompt, /researcher owns web_research/);
  assert.match(prompt, /providerFailures/);
  assert.match(prompt, /retrieve_memory/);
  assert.match(prompt, /placeholder/);
  assert.match(prompt, /What can you do\?/);
});

test('chat workflow reports context budget for selected model', () => {
  const report = createContextBudgetReport('ollama-cloud/minimax-m3');

  assert.equal(report?.modelSpecifier, 'ollama-cloud/minimax-m3');
  assert.equal(report?.enforcedContextWindow, 524_288);
  assert.equal(report?.outputReserveTokens, 131_072);
  assert.equal(report?.usableInputTokens, 393_216);
  assert.equal(report?.status, 'normal');
});

test('chat workflow retries with backup model when primary is recoverably unavailable', async () => {
  const attemptedModels: string[] = [];
  const session = {
    async compact() {},
    prompt: async (_prompt: string, options?: { model?: string }) => {
      attemptedModels.push(options?.model ?? '');
      if (attemptedModels.length === 1) {
        throw new Error('provider unavailable');
      }

      return createPromptResponse('codex-brain', 'gpt-5.5', 'backup answer');
    },
  };

  const response = await run({
    env: {
      OLLAMA_API_KEY: 'test-key',
      CODEX_BRAIN_LOCAL_API_KEY: 'test-key',
      CODEX_BRAIN_LOCAL_API_URL: 'https://dt1.example.test/v1',
    },
    payload: {
      text: 'Hello',
      actorId: 'user-1',
      conversationId: 'chat-failover',
    },
    init: async () => ({
      name: 'fake-orchestrator',
      session: async () => session,
    }),
  } as never);

  assert.deepEqual(attemptedModels, ['ollama-cloud/minimax-m3', 'codex-brain/gpt-5.5']);
  assert.equal(response.text, 'backup answer');
  assert.equal(response.modelFailover?.fallbackUsed, true);
  assert.deepEqual(response.modelFailover?.attempts.map((attempt) => attempt.status), ['failed', 'used']);
});

test('chat workflow does not retry backup for context budget model errors', async () => {
  const attemptedModels: string[] = [];
  const session = {
    async compact() {},
    prompt: async (_prompt: string, options?: { model?: string }) => {
      attemptedModels.push(options?.model ?? '');
      throw new Error('maximum context length exceeded');
    },
  };

  await assert.rejects(
    () =>
      run({
        env: {
          OLLAMA_API_KEY: 'test-key',
          CODEX_BRAIN_LOCAL_API_KEY: 'test-key',
          CODEX_BRAIN_LOCAL_API_URL: 'https://dt1.example.test/v1',
        },
        payload: {
          text: 'Hello',
          actorId: 'user-1',
          conversationId: 'chat-no-context-failover',
        },
        init: async () => ({
          name: 'fake-orchestrator',
          session: async () => session,
        }),
      } as never),
    /maximum context length exceeded/,
  );

  assert.deepEqual(attemptedModels, ['ollama-cloud/minimax-m3']);
});

test('recoverable model failure classifier avoids context and abort retries', () => {
  assert.equal(isRecoverableModelFailure(new Error('provider unavailable')), true);
  assert.equal(isRecoverableModelFailure(new Error('maximum context length exceeded')), false);
  assert.equal(isRecoverableModelFailure(new DOMException('aborted', 'AbortError')), false);
});

function createPromptResponse(provider: string, id: string, text: string): PromptResponse {
  return {
    text,
    model: {
      provider,
      id,
    },
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
  };
}
