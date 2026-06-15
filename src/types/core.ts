export type RegistryScope = 'base' | 'user';

export type ConnectorKind = 'telegram' | 'web-api' | 'tui' | 'scheduled-job' | 'test' | 'unknown';

export type MessageKind = 'chat.message' | 'command' | 'workflow.event';

export type OrchestratorStatus = 'ok' | 'error';

export type WorkerStatus = 'completed' | 'failed' | 'not_implemented';

export type RagProviderKind = 'memory' | 'web-search' | 'document-index' | 'future-vector';

export type RetrievalCaller = 'orchestrator' | 'researcher' | 'research-workflow' | 'system';

export interface RegistryDefinition {
  id: string;
  name: string;
  description: string;
  scope: RegistryScope;
  enabled: boolean;
  tags?: string[];
}

export interface AgentDefinition extends RegistryDefinition {
  kind: 'orchestrator' | 'worker' | 'subagent';
  model?: string | false;
  capabilities: string[];
}

export interface ToolDefinition extends RegistryDefinition {
  kind: 'flue-native' | 'registry-gateway' | 'placeholder';
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

export interface SkillDefinition extends RegistryDefinition {
  kind: 'workflow-knowledge' | 'playbook' | 'placeholder';
  requiredTools: string[];
}

export interface ProtocolDefinition extends RegistryDefinition {
  priority: number;
  appliesTo: ProtocolSelector;
  rules: string[];
  source: 'sqlite' | 'file' | 'seed';
}

export interface ProtocolSelector {
  connector?: ConnectorKind;
  userId?: string;
  clientId?: string;
  projectId?: string;
  task?: string;
  workflow?: string;
  messageKind?: MessageKind;
}

export interface ProtocolBundle {
  eventId: string;
  protocols: ProtocolDefinition[];
  loadedAt: string;
}

export interface NormalizedMessageEvent {
  id: string;
  connector: ConnectorKind;
  kind: MessageKind;
  text: string;
  receivedAt: string;
  actor: {
    id: string;
    displayName?: string;
  };
  conversation: {
    id: string;
    threadId?: string;
  };
  context?: {
    clientId?: string;
    projectId?: string;
    workflow?: string;
    task?: string;
  };
  deliveryKind?: string;
  deliveryId?: string;
  acceptedAt?: string;
  raw?: unknown;
}

export interface OrchestratorResponse {
  id: string;
  eventId: string;
  status: OrchestratorStatus;
  routedTo: string;
  text: string;
  protocolBundle: ProtocolBundle;
  retrievedContext: RagResult;
  toolCalls: string[];
  diagnostics: {
    protocolCount: number;
    retrievedContextCount: number;
    registryCounts: {
      tools: number;
      skills: number;
      agents: number;
    };
  };
}

export interface WorkerRunRequest {
  id: string;
  workerId: string;
  event: NormalizedMessageEvent;
  instructions: string;
  context: RetrievedContext[];
}

export interface WorkerRunResult {
  id: string;
  workerId: string;
  status: WorkerStatus;
  summary: string;
  artifacts: Array<{
    name: string;
    uri: string;
  }>;
}

export interface RegistryLookupResult<TDefinition extends RegistryDefinition> {
  found: boolean;
  definition?: TDefinition;
  reason?: string;
}

export interface RagQuery {
  eventId: string;
  text: string;
  actorId: string;
  conversationId: string;
  sessionId?: string;
  providers?: RagProviderKind[];
  caller?: RetrievalCaller;
  limit?: number;
}

export interface RetrievedContext {
  id: string;
  provider: RagProviderKind;
  title: string;
  content: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface RagResultMetadata {
  providerFailures?: Array<{
    provider: RagProviderKind;
    name?: string;
    message: string;
  }>;
  retrieval?: {
    selectedProviders: RagProviderKind[];
  };
  webFetch?: {
    mode: 'auto' | 'always' | 'never';
    attempted: number;
    succeeded: number;
    failed: number;
  };
  budget?: {
    maxContextTokens: number;
    usedContextTokens: number;
    truncatedContextCount: number;
    omittedContextCount: number;
  };
}

export interface RagResult {
  query: RagQuery;
  retrievedAt: string;
  contexts: RetrievedContext[];
  metadata?: RagResultMetadata;
}
