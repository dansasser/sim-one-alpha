import type { RegistryDefinition, RegistryLookupResult } from '../types/index.js';

export interface Registry<TDefinition extends RegistryDefinition> {
  register(definition: TDefinition): void;
  get(id: string): RegistryLookupResult<TDefinition>;
  require(id: string): TDefinition;
  list(options?: { enabledOnly?: boolean; scope?: TDefinition['scope'] }): TDefinition[];
}

export class InMemoryRegistry<TDefinition extends RegistryDefinition>
  implements Registry<TDefinition>
{
  private readonly definitions = new Map<string, TDefinition>();

  constructor(seed: TDefinition[] = []) {
    for (const definition of seed) {
      this.register(definition);
    }
  }

  register(definition: TDefinition): void {
    if (this.definitions.has(definition.id)) {
      throw new Error(`Registry definition already exists: ${definition.id}`);
    }

    this.definitions.set(definition.id, Object.freeze({ ...definition }));
  }

  get(id: string): RegistryLookupResult<TDefinition> {
    const definition = this.definitions.get(id);
    if (!definition) {
      return { found: false, reason: `No definition registered for ${id}` };
    }

    return { found: true, definition };
  }

  require(id: string): TDefinition {
    const result = this.get(id);
    if (!result.found || !result.definition) {
      throw new Error(result.reason ?? `No definition registered for ${id}`);
    }

    return result.definition;
  }

  list(options: { enabledOnly?: boolean; scope?: TDefinition['scope'] } = {}): TDefinition[] {
    return [...this.definitions.values()]
      .filter((definition) => (options.enabledOnly ? definition.enabled : true))
      .filter((definition) => (options.scope ? definition.scope === options.scope : true))
      .sort((left, right) => left.id.localeCompare(right.id));
  }
}

