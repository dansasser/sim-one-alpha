import { createCapabilityStore } from './capability-store.js';
import { isBuiltinName } from './builtin-registry.js';
import type { CapabilityKind } from './types.js';

export interface CollisionResult {
  collision: boolean;
  source: 'builtin' | 'existing' | null;
  message?: string;
}

export function checkNameCollision(kind: CapabilityKind, id: string): CollisionResult {
  if (isBuiltinName(kind, id)) {
    return {
      collision: true,
      source: 'builtin',
      message: `Name '${id}' conflicts with a built-in capability. Choose a different name.`,
    };
  }

  const store = createCapabilityStore({});
  try {
    const existing = store.get(kind, id);
    if (existing) {
      return {
        collision: true,
        source: 'existing',
        message: `Name '${id}' already exists as a ${existing.kind} capability. Choose a different name.`,
      };
    }
  } finally {
    store.close();
  }

  return { collision: false, source: null };
}