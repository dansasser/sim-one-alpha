import type { WebFetchMode } from '../../engine/workflows/retrieval.js';
import type { ResearchDepth, ResearchFreshness } from '../../engine/workflows/web-research.js';

/**
 * Reads a positive integer from a number or numeric string.
 */
export function readPositiveInteger(value: unknown): number | undefined {
  return readInteger(value, { minimum: 1 });
}

/**
 * Reads a non-negative integer from a number or numeric string.
 */
export function readNonNegativeInteger(value: unknown): number | undefined {
  return readInteger(value, { minimum: 0 });
}

/**
 * Reads a supported web-fetch mode value.
 */
export function readWebFetchMode(value: unknown): WebFetchMode | undefined {
  return value === 'auto' || value === 'always' || value === 'never' ? value : undefined;
}

/**
 * Reads a supported research cache freshness value.
 */
export function readResearchFreshness(value: unknown): ResearchFreshness | undefined {
  return value === 'auto' || value === 'fresh' || value === 'cached' ? value : undefined;
}

/**
 * Reads a supported research depth value.
 */
export function readResearchDepth(value: unknown): ResearchDepth | undefined {
  return value === 'basic' || value === 'standard' || value === 'deep' ? value : undefined;
}

/**
 * Reads an integer above the configured minimum from unknown input.
 */
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
