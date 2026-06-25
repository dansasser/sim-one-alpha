import { loadGoromboConfig } from '../core/config/gorombo-config.js';
import { createGoromboPersistenceRuntime } from '../engine/session/session-persistence.js';
import { reconcileCapabilitiesFromConfig } from '../engine/capabilities/capability-config-reconcile.js';

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