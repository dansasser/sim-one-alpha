import { AsyncLocalStorage } from 'node:async_hooks';
import type { NormalizedMessageEvent } from '../../core/types/index.js';

const trustedMessageEvent = new AsyncLocalStorage<NormalizedMessageEvent>();

export function runWithTrustedMessageEvent<T>(event: NormalizedMessageEvent, operation: () => T): T {
  return trustedMessageEvent.run(event, operation);
}

export function getTrustedMessageEvent(): NormalizedMessageEvent | undefined {
  return trustedMessageEvent.getStore();
}
