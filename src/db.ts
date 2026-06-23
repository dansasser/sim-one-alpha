import { loadGoromboConfig } from './config/gorombo-config.js';
import { createGoromboPersistenceRuntime } from './session/session-persistence.js';
import { reconcileCapabilitiesFromConfig } from './capabilities/capability-config-reconcile.js';

const goromboConfig = loadGoromboConfig();

export const goromboPersistenceRuntime = createGoromboPersistenceRuntime(goromboConfig);

try {
  const result = reconcileCapabilitiesFromConfig(goromboConfig.capabilities);
  if (result.inserted.length > 0) {
    console.log(`[capabilities] Reconciled ${result.inserted.length} capability(ies) from config: ${result.inserted.join(', ')}`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[capabilities] Config reconcile failed: ${message}`);
}

export default goromboPersistenceRuntime.adapter;