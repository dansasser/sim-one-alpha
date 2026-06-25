import { registerCodexBrainProvider } from '../../../core/models/providers/codex-brain/index.js';
import { registerOllamaCloudProvider } from '../../../core/models/providers/ollama-cloud/index.js';
import { registerOllamaLocalProvider } from '../../../core/models/providers/ollama-local/index.js';

export function configureModelProviders(env: Record<string, unknown> = process.env): void {
  registerOllamaCloudProvider(env);
  registerCodexBrainProvider(env);
  registerOllamaLocalProvider(env);
}
