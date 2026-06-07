export type ModelRole =
  | 'agentic-chat'
  | 'tool-use'
  | 'coding'
  | 'rag'
  | 'protocol-reasoning'
  | 'memory-synthesis';

export type ModelCapability =
  | 'tools'
  | 'thinking'
  | 'coding'
  | 'long-context'
  | 'vision'
  | 'local'
  | 'cloud';

export interface AgentModelProfile {
  key: string;
  providerId: string;
  modelId: string;
  specifier: string;
  displayName: string;
  description: string;
  roles: ModelRole[];
  capabilities: ModelCapability[];
  contextWindow: number;
  maxTokens: number;
  enabled: boolean;
  env?: {
    baseUrl?: string;
    apiKey?: string;
  };
}

export interface ModelRegistry {
  defaultAgentModel: string;
  profiles: AgentModelProfile[];
  byKey: Map<string, AgentModelProfile>;
}
