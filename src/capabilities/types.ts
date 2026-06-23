export type CapabilityKind = 'skill' | 'tool' | 'worker' | 'mcp';
export type CapabilitySource = 'github' | 'local' | 'npm' | 'builtin';
export type CapabilityInstalledBy = 'cli' | 'agent' | 'seed';

export interface CapabilityRecord {
  id: string;
  kind: CapabilityKind;
  name: string;
  description: string;
  source: CapabilitySource;
  sourceRef: string;
  version: string | null;
  enabled: boolean;
  config: CapabilityConfig;
  installedAt: string;
  updatedAt: string;
  installedBy: CapabilityInstalledBy;
}

export interface CapabilityConfig {
  envVarNames?: string[];
  scopes?: string[];
  modelCard?: string;
  skillArgs?: Record<string, unknown>;
  mcpUrl?: string;
  mcpTransport?: 'streamable-http' | 'sse';
  mcpTokenEnv?: string;
  workerModelCard?: string;
  workerInstructions?: string;
  [key: string]: unknown;
}

export interface CapabilityStore {
  list(options?: { enabledOnly?: boolean; kind?: CapabilityKind }): CapabilityRecord[];
  get(kind: CapabilityKind, id: string): CapabilityRecord | undefined;
  insert(record: CapabilityRecord): void;
  update(kind: CapabilityKind, id: string, patch: Partial<Omit<CapabilityRecord, 'id' | 'kind'>>): void;
  remove(kind: CapabilityKind, id: string): boolean;
  setEnabled(kind: CapabilityKind, id: string, enabled: boolean): void;
  close(): void;
}