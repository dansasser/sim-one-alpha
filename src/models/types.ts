export type ModelRole =
  | 'agentic-chat'
  | 'tool-use'
  | 'coding'
  | 'rag'
  | 'protocol-reasoning'
  | 'memory-synthesis'
  | 'embedding';

export type ModelCapability =
  | 'tools'
  | 'thinking'
  | 'coding'
  | 'long-context'
  | 'vision'
  | 'video'
  | 'embedding'
  | 'local'
  | 'cloud';

export interface AgentModelCard {
  key: string;
  providerId: string;
  modelId: string;
  specifier: string;
  displayName: string;
  description: string;
  roles: ModelRole[];
  capabilities: ModelCapability[];
  contextWindow: number;
  guaranteedContextWindow?: number;
  providerReportedContextWindow?: number;
  maxOutputTokens: number;
  maxTokens: number;
  enabled: boolean;
  source?: {
    name: string;
    url?: string;
    checkedAt: string;
    notes?: string;
  };
  env?: {
    baseUrl?: string;
    apiKey?: string | string[];
  };
}

export interface ModelRegistry {
  selectedModelCard: AgentModelCard;
  backupModelCard?: AgentModelCard;
  modelCandidates: AgentModelCard[];
  cards: AgentModelCard[];
  byKey: Map<string, AgentModelCard>;
}
