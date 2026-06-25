import type { MemoryEngineErrorKind } from '../../core/types/memory.js';

/** Typed error raised by `MemoryEngine` implementations. */
export { MemoryEngineError } from '../../engine/memory/memory-engine.js';

/** Re-export the kind type for callers that import from this module. */
export type { MemoryEngineErrorKind } from '../../core/types/memory.js';
