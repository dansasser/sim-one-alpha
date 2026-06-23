import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { createCapabilityStore } from '../capabilities/capability-store.js';
import { materializeCapability } from '../capabilities/skill-materializer.js';
import { checkNameCollision } from '../capabilities/collision-check.js';
import type { CapabilityKind, CapabilityRecord, CapabilitySource } from '../capabilities/types.js';

const CAPABILITY_KIND_VALUES = ['skill', 'tool', 'worker', 'mcp'] as const;

function now(): string {
  return new Date().toISOString();
}

function resolveSource(sourceRef: string): CapabilitySource {
  if (sourceRef.startsWith('http://') || sourceRef.startsWith('https://') || sourceRef.startsWith('git@')) {
    return 'github';
  }
  return 'local';
}

function insertCapability(
  kind: CapabilityKind,
  id: string,
  name: string,
  description: string,
  sourceRef: string,
  config: Record<string, unknown>,
  autoEnable: boolean,
  materialize = false,
): string {
  const collision = checkNameCollision(kind, id);
  if (collision.collision) {
    return collision.message ?? `Name '${id}' conflicts with an existing capability.`;
  }

  const store = createCapabilityStore({});
  try {
    const record: CapabilityRecord = {
      id,
      kind,
      name,
      description,
      source: resolveSource(sourceRef),
      sourceRef,
      version: null,
      enabled: autoEnable,
      config,
      installedAt: now(),
      updatedAt: now(),
      installedBy: 'agent',
    };
    store.insert(record);

    if (autoEnable || materialize) {
      try {
        materializeCapability({ record });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `${kind} ${id} added${autoEnable ? ' and enabled' : ''}, but source materialization failed: ${message}. The capability directory may not be ready until the next restart.`;
      }
    }

    if (autoEnable) {
      return `${kind} ${id} added and enabled. Restart the service to activate it.`;
    }

    return `${kind} ${id} added but NOT enabled (requires approval). The user must approve it via CLI (\`pnpm capabilities:enable ${kind} ${id}\`) or the TUI approval surface, then restart the service.`;
  } finally {
    store.close();
  }
}

export const addSkillTool = defineTool({
  name: 'add_skill',
  description:
    'Add a user-defined skill from a GitHub URL or local directory path. Skills are markdown-only (no code execution) and are auto-enabled. The user must restart the service after adding.',
  parameters: v.object({
    sourceRef: v.pipe(v.string(), v.description('GitHub URL (https://...) or local directory path containing SKILL.md')),
    id: v.pipe(v.string(), v.description('Unique capability id, e.g. "my-jira-skill"')),
    name: v.pipe(v.string(), v.description('Display name for the skill')),
    description: v.pipe(v.string(), v.description('Short description of what the skill does')),
  }),
  execute: async ({ sourceRef, id, name, description }) => {
    return insertCapability('skill', id, name, description, sourceRef, {}, true);
  },
});

export const addToolCapabilityTool = defineTool({
  name: 'add_tool',
  description:
    'Add a user-defined tool from a GitHub URL or local directory path. The tool module must export a defineTool(...) result (default export, array export, or named exports). Tools execute arbitrary code — requires user approval before enabling.',
  parameters: v.object({
    sourceRef: v.pipe(v.string(), v.description('GitHub URL or local directory path containing index.mjs')),
    id: v.pipe(v.string(), v.description('Unique capability id, e.g. "my-jira-lookup"')),
    name: v.pipe(v.string(), v.description('Display name for the tool')),
    description: v.pipe(v.string(), v.description('Short description of what the tool does')),
  }),
  execute: async ({ sourceRef, id, name, description }) => {
    return insertCapability('tool', id, name, description, sourceRef, {}, false, true);
  },
});

export const addWorkerTool = defineTool({
  name: 'add_worker',
  description:
    'Add a user-defined worker (subagent) from a GitHub URL or local directory path. The worker module must export a defineAgentProfile(...) result. Workers execute arbitrary code — requires user approval before enabling.',
  parameters: v.object({
    sourceRef: v.pipe(v.string(), v.description('GitHub URL or local directory path containing index.mjs')),
    id: v.pipe(v.string(), v.description('Unique capability id, e.g. "my-writer"')),
    name: v.pipe(v.string(), v.description('Display name for the worker')),
    description: v.pipe(v.string(), v.description('Short description of what the worker does')),
  }),
  execute: async ({ sourceRef, id, name, description }) => {
    return insertCapability('worker', id, name, description, sourceRef, {}, false, true);
  },
});

export const addMcpServerTool = defineTool({
  name: 'add_mcp_server',
  description:
    'Add an MCP server connection. The server must be reachable at the provided URL. MCP servers expose tools that execute remote code — requires user approval before enabling.',
  parameters: v.object({
    id: v.pipe(v.string(), v.description('Unique capability id, e.g. "my-inventory-mcp"')),
    name: v.pipe(v.string(), v.description('Display name for the MCP server')),
    description: v.pipe(v.string(), v.description('Short description of what the MCP server provides')),
    url: v.pipe(v.string(), v.description('MCP server endpoint URL')),
    transport: v.optional(v.picklist(['streamable-http', 'sse']), 'streamable-http'),
    tokenEnv: v.optional(v.pipe(v.string(), v.description('Name of the environment variable containing the auth token (e.g. MY_MCP_TOKEN)'))),
  }),
  execute: async ({ id, name, description, url, transport, tokenEnv }) => {
    const config: Record<string, unknown> = {
      mcpUrl: url,
      mcpTransport: transport ?? 'streamable-http',
    };
    if (tokenEnv) {
      config.mcpTokenEnv = tokenEnv;
    }
    return insertCapability('mcp', id, name, description, `mcp://${id}`, config, false);
  },
});

export const listCapabilitiesTool = defineTool({
  name: 'list_capabilities',
  description:
    'List all registered user-defined capabilities (skills, tools, workers, MCP servers) with their enabled status. Use this to check what capabilities are available or pending approval.',
  parameters: v.object({
    kind: v.optional(v.picklist(CAPABILITY_KIND_VALUES)),
    enabledOnly: v.optional(v.boolean()),
  }),
  execute: async ({ kind, enabledOnly }) => {
    const store = createCapabilityStore({});
    try {
      const records = store.list({
        enabledOnly: enabledOnly ?? false,
        kind: kind as CapabilityKind | undefined,
      });
      const safe = records.map(redactCapabilityRecord);
      return JSON.stringify(safe, null, 2);
    } finally {
      store.close();
    }
  },
});

function redactCapabilityRecord(record: CapabilityRecord) {
  return {
    id: record.id,
    kind: record.kind,
    name: record.name,
    description: record.description,
    source: record.source,
    version: record.version,
    enabled: record.enabled,
    installedAt: record.installedAt,
    updatedAt: record.updatedAt,
    installedBy: record.installedBy,
  };
}

export const capabilityTools = [
  addSkillTool,
  addToolCapabilityTool,
  addWorkerTool,
  addMcpServerTool,
  listCapabilitiesTool,
];