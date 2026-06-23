import { connectMcpServer, type McpServerConnection, type ToolDefinition } from '@flue/runtime';
import type { CapabilityRecord } from './types.js';

export interface McpBrokerResult {
  tools: ToolDefinition[];
  connections: McpServerConnection[];
}

export async function connectUserMcpServers(
  mcpRecords: CapabilityRecord[],
  env: Record<string, unknown> = process.env,
): Promise<McpBrokerResult> {
  const connections: McpServerConnection[] = [];
  const allTools: ToolDefinition[] = [];

  for (const record of mcpRecords) {
    const url = record.config.mcpUrl;
    if (!url) continue;

    const headers: Record<string, string> = {};
    const tokenEnv = record.config.mcpTokenEnv;
    if (tokenEnv) {
      const token = readEnv(env, tokenEnv);
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
    }

    try {
      const connection = await connectMcpServer(record.id, {
        url,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        transport: record.config.mcpTransport ?? 'streamable-http',
      });
      connections.push(connection);
      allTools.push(...connection.tools);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[capabilities] MCP connection failed for ${record.id}: ${message}`);
    }
  }

  return { tools: allTools, connections };
}

function readEnv(env: Record<string, unknown>, key: string): string | undefined {
  const value = env[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}