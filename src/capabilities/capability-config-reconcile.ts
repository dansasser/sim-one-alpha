import type { GoromboCapabilityConfig } from '../config/gorombo-config.js';
import { createCapabilityStore } from './capability-store.js';
import { isBuiltinName } from './builtin-registry.js';
import type { CapabilityRecord } from './types.js';

export interface ReconcileResult {
  inserted: string[];
  skipped: string[];
  conflicts: string[];
}

export function reconcileCapabilitiesFromConfig(
  configCapabilities: GoromboCapabilityConfig[] | undefined,
): ReconcileResult {
  if (!configCapabilities || !Array.isArray(configCapabilities) || configCapabilities.length === 0) {
    return { inserted: [], skipped: [], conflicts: [] };
  }

  const store = createCapabilityStore({});
  const inserted: string[] = [];
  const skipped: string[] = [];
  const conflicts: string[] = [];

  try {
    for (const cap of configCapabilities) {
      const allExisting = store.list();
      const existing = allExisting.find((c) => c.id === cap.id);
      if (existing) {
        skipped.push(cap.id);
        continue;
      }

      if (isBuiltinName(cap.kind, cap.id)) {
        conflicts.push(cap.id);
        console.warn(`[capabilities] Config entry '${cap.id}' conflicts with a built-in capability — skipped.`);
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

  return { inserted, skipped, conflicts };
}