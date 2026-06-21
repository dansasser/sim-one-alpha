import type { MemoryEngineErrorKind } from '../types/memory.js';

/** Typed error raised by `MemoryEngine` implementations. */
export { MemoryEngineError } from './memory-engine.js';

/** Re-export the kind type for callers that import from this module. */
export type { MemoryEngineErrorKind } from '../types/memory.js';
