import {
  assertPublicCodingWorkerEvent,
  createCodingWorkerEvent,
  type CodingWorkerEvent,
} from './coding-worker-events.js';

export interface CodingProgressReporter {
  emit(event: Omit<CodingWorkerEvent, 'timestamp'> & { timestamp?: string }): void;
  events(): CodingWorkerEvent[];
}

export class InMemoryCodingProgressReporter implements CodingProgressReporter {
  readonly #events: CodingWorkerEvent[] = [];

  emit(event: Omit<CodingWorkerEvent, 'timestamp'> & { timestamp?: string }): void {
    this.#events.push(createCodingWorkerEvent(event));
  }

  events(): CodingWorkerEvent[] {
    return [...this.#events];
  }
}

export function assertPublicCodingWorkerEvents(events: CodingWorkerEvent[]): void {
  for (const event of events) {
    assertPublicCodingWorkerEvent(event);
  }
}

