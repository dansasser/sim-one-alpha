import type { RagQuery, RetrievedContext } from '../types/index.js';
import type { MemoryProvider } from './memory-provider.js';

export class MemoryRouter {
  constructor(private readonly provider: MemoryProvider) {}

  retrieve(query: RagQuery): Promise<RetrievedContext[]> {
    return this.provider.retrieve(query);
  }
}

