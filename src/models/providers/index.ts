import { registerCodexBrainProvider } from './codex-brain/index.js';
import { registerOllamaCloudProvider } from './ollama-cloud/index.js';
import { registerOllamaLocalProvider } from './ollama-local/index.js';

export function configureModelProviders(env: Record<string, unknown> = process.env): void {
  registerOllamaCloudProvider(env);
  registerCodexBrainProvider(env);
  registerOllamaLocalProvider(env);
}
