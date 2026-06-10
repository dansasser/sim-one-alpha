import { configureModelProviders } from './providers/index.js';

export function configureModelRuntime(): void {
  configureModelProviders();
}

configureModelRuntime();
