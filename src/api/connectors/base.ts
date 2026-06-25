import type { NormalizedMessageEvent } from '../../core/types/index.js';

export interface Connector<TInput> {
  normalize(input: TInput): NormalizedMessageEvent;
}

export function createEventId(prefix: string): string {
  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
}

