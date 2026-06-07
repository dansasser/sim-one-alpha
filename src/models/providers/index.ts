import { createCodexBrainCard } from '../cards/index.js';
import { registerOllamaCloudProvider } from './ollama-cloud.js';
import { registerOllamaLocalProvider } from './ollama-local.js';

export function configureModelProviders(env: Record<string, unknown>): void {
  registerOllamaCloudProvider(env);

  const codexBrainModel = readString(env.OLLAMA_CODEX_BRAIN_MODEL);
  registerOllamaLocalProvider(env, codexBrainModel ? [createCodexBrainCard(codexBrainModel)] : []);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
