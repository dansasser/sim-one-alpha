import {
  createAgent,
  defineAgentProfile,
  registerProvider,
  type AgentRouteHandler,
} from '@flue/runtime';
import { loadProtocolsTool, retrieveContextTool, retrieveMemoryTool } from '../tools/index.js';

export const route: AgentRouteHandler = async (_c, next) => next();

const codingWorker = defineAgentProfile({
  name: 'coding_worker',
  model: false,
  instructions:
    'Placeholder coding worker profile. Do not autonomously edit code yet; future phases add plan, edit, test, debug loop, diff, and approval behavior.',
});

const instructions = `
You are the GOROMBO main orchestrator.

Load protocols before final reasoning, retrieve memory/context when useful, use registry-backed tools, and delegate only to defined workers.
This Phase 1 foundation contains placeholder providers; do not claim real external integrations are active unless a concrete provider is configured.
`;

export default createAgent(({ env }) => {
  registerConfiguredProviders(env);

  return {
    model: resolveAgentModel(env),
    instructions,
    tools: [loadProtocolsTool, retrieveMemoryTool, retrieveContextTool],
    subagents: [codingWorker],
  };
});

function resolveAgentModel(env: Record<string, unknown>): string {
  const configuredModel = readString(env.GOROMBO_MODEL);
  if (configuredModel) {
    return configuredModel;
  }

  if (readString(env.OLLAMA_API_KEY) || readString(env.OLLAMA_BASE_URL)) {
    return `ollama/${readString(env.OLLAMA_MODEL) ?? 'deepseek-v4-pro:cloud'}`;
  }

  return 'openai/gpt-5.5';
}

function registerConfiguredProviders(env: Record<string, unknown>): void {
  if (!readString(env.OLLAMA_API_KEY) && !readString(env.OLLAMA_BASE_URL) && !readString(env.OLLAMA_MODEL)) {
    return;
  }

  const modelId = readString(env.OLLAMA_MODEL) ?? 'deepseek-v4-pro:cloud';

  registerProvider('ollama', {
    api: 'openai-completions',
    baseUrl: readString(env.OLLAMA_BASE_URL) ?? 'http://localhost:11434/v1',
    apiKey: readString(env.OLLAMA_API_KEY) ?? 'ollama',
    contextWindow: 128000,
    maxTokens: 32000,
    models: {
      [modelId]: {
        contextWindow: 128000,
        maxTokens: 32000,
      },
    },
  });
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
