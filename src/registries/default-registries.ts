import type {
  AgentDefinition,
  ProtocolDefinition,
  SkillDefinition,
  ToolDefinition,
} from '../types/index.js';
import { baseProtocolSeeds } from '../protocols/protocol-provider.js';
import { InMemoryRegistry } from './generic-registry.js';

export function createDefaultToolRegistry() {
  return new InMemoryRegistry<ToolDefinition>([
    {
      id: 'protocol.load',
      name: 'Load Protocols',
      description: 'Loads applicable runtime protocol records before orchestration.',
      scope: 'base',
      enabled: true,
      kind: 'flue-native',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      tags: ['protocols', 'sqlite-placeholder'],
    },
    {
      id: 'memory.retrieve',
      name: 'Retrieve Memory',
      description: 'Retrieves relevant memory records for the current message.',
      scope: 'base',
      enabled: true,
      kind: 'flue-native',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      tags: ['memory', 'retrieval'],
    },
    {
      id: 'rag.retrieve',
      name: 'Retrieve Context',
      description: 'Routes retrieval across memory, web search, document index, and future providers.',
      scope: 'base',
      enabled: true,
      kind: 'registry-gateway',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      tags: ['rag', 'retrieval'],
    },
  ]);
}

export function createDefaultSkillRegistry() {
  return new InMemoryRegistry<SkillDefinition>([
    {
      id: 'chat.route-basic',
      name: 'Basic Chat Routing',
      description: 'Reusable workflow knowledge for routing a normalized chat event.',
      scope: 'base',
      enabled: true,
      kind: 'workflow-knowledge',
      requiredTools: ['protocol.load', 'rag.retrieve'],
      tags: ['chat', 'routing'],
    },
  ]);
}

export function createDefaultAgentRegistry() {
  return new InMemoryRegistry<AgentDefinition>([
    {
      id: 'main-orchestrator',
      name: 'Main Orchestrator',
      description: 'Coordinates protocols, registries, memory/RAG, tools, and workers.',
      scope: 'base',
      enabled: true,
      kind: 'orchestrator',
      model: false,
      capabilities: ['chat-routing', 'protocol-loading', 'retrieval'],
      tags: ['orchestrator'],
    },
    {
      id: 'coding-worker',
      name: 'Coding Worker Placeholder',
      description: 'Placeholder for future plan/edit/test/debug/diff/approval behavior.',
      scope: 'base',
      enabled: true,
      kind: 'worker',
      model: false,
      capabilities: ['placeholder'],
      tags: ['worker', 'coding'],
    },
  ]);
}

export function createDefaultProtocolRegistry(seed: ProtocolDefinition[]) {
  return new InMemoryRegistry<ProtocolDefinition>(seed);
}

export interface DefaultRegistries {
  tools: ReturnType<typeof createDefaultToolRegistry>;
  skills: ReturnType<typeof createDefaultSkillRegistry>;
  agents: ReturnType<typeof createDefaultAgentRegistry>;
  protocols: ReturnType<typeof createDefaultProtocolRegistry>;
}

export function createDefaultRegistries(): DefaultRegistries {
  return {
    tools: createDefaultToolRegistry(),
    skills: createDefaultSkillRegistry(),
    agents: createDefaultAgentRegistry(),
    protocols: createDefaultProtocolRegistry(baseProtocolSeeds),
  };
}
