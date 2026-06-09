import type { WebFetchMode } from '../workflows/retrieval.js';
import type { ResearchFreshness } from '../workflows/web-research.js';

export function readPositiveInteger(value: unknown): number | undefined {
  return readInteger(value, { minimum: 1 });
}

export function readNonNegativeInteger(value: unknown): number | undefined {
  return readInteger(value, { minimum: 0 });
}

export function readWebFetchMode(value: unknown): WebFetchMode | undefined {
  return value === 'auto' || value === 'always' || value === 'never' ? value : undefined;
}

export function readResearchFreshness(value: unknown): ResearchFreshness | undefined {
  return value === 'auto' || value === 'fresh' || value === 'cached' ? value : undefined;
}

function readInteger(value: unknown, options: { minimum: number }): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= options.minimum) {
    return Math.floor(value);
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) && parsed >= options.minimum ? Math.floor(parsed) : undefined;
  }

  return undefined;
}
