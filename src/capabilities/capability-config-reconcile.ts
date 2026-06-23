import type { GoromboCapabilityConfig } from '../config/gorombo-config.js';
import { createCapabilityStore } from './capability-store.js';
import type { CapabilityRecord } from './types.js';

export interface ReconcileResult {
  inserted: string[];
  skipped: string[];
}

export function reconcileCapabilitiesFromConfig(
  configCapabilities: GoromboCapabilityConfig[] | undefined,
): ReconcileResult {
  if (!configCapabilities || !Array.isArray(configCapabilities) || configCapabilities.length === 0) {
    return { inserted: [], skipped: [] };
  }

  const store = createCapabilityStore({});
  const inserted: string[] = [];
  const skipped: string[] = [];

  try {
    for (const cap of configCapabilities) {
      const existing = store.get(cap.kind, cap.id);
      if (existing) {
        skipped.push(cap.id);
        continue;
      }

      const now = new Date().toISOString();
      const record: CapabilityRecord = {
        id: cap.id,
        kind: cap.kind,
        name: cap.name,
        description: cap.description,
        source: cap.source,
        sourceRef: cap.sourceRef,
        version: cap.version ?? null,
        enabled: cap.enabled ?? cap.kind === 'skill',
        config: cap.config ?? {},
        installedAt: now,
        updatedAt: now,
        installedBy: 'seed',
      };
      store.insert(record);
      inserted.push(cap.id);
    }
  } finally {
    store.close();
  }

  return { inserted, skipped };
}