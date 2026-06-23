import { connectMcpServer, type McpServerConnection, type ToolDefinition } from '@flue/runtime';
import type { CapabilityRecord } from './types.js';

export interface McpBrokerResult {
  tools: ToolDefinition[];
  connections: McpServerConnection[];
  failures: Array<{ id: string; error: string }>;
}

const ALLOWED_MCP_TOKEN_ENV = new Set([
  'GOROMBO_MCP_TOKEN',
  'MCP_AUTH_TOKEN',
  'MCP_TOKEN',
]);

export async function connectUserMcpServers(
  mcpRecords: CapabilityRecord[],
  env: Record<string, unknown> = process.env,
): Promise<McpBrokerResult> {
  if (mcpRecords.length === 0) {
    return { tools: [], connections: [], failures: [] };
  }

  const connections: McpServerConnection[] = [];
  const allTools: ToolDefinition[] = [];
  const failures: Array<{ id: string; error: string }> = [];

  for (const record of mcpRecords) {
    const url = record.config.mcpUrl;
    if (!url) continue;

    const headers: Record<string, string> = {};
    const tokenEnv = record.config.mcpTokenEnv;
    if (tokenEnv) {
      if (!ALLOWED_MCP_TOKEN_ENV.has(tokenEnv)) {
        const message = `MCP token env var "${tokenEnv}" is not in the allowlist`;
        failures.push({ id: record.id, error: message });
        continue;
      }
      const token = readEnv(env, tokenEnv);
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
    }

    try {
      const connection = await withTimeout(
        connectMcpServer(record.id, {
          url,
          headers: Object.keys(headers).length > 0 ? headers : undefined,
          transport: record.config.mcpTransport ?? 'streamable-http',
          timeoutMs: 10_000,
        }),
        15_000,
        `MCP connect ${record.id}`,
      );
      connections.push(connection);
      allTools.push(...connection.tools);
      console.log(`[capabilities] MCP connected: ${record.id} (${connection.tools.length} tools)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ id: record.id, error: message });
      console.error(`[capabilities] MCP connection failed for ${record.id}: ${message}`);
    }
  }

  return { tools: allTools, connections, failures };
}

function readEnv(env: Record<string, unknown>, key: string): string | undefined {
  const value = env[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timedOut = false;
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      timedOut = true;
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });
  // Swallow late rejection from the original promise if we already timed out,
  // so it doesn't become an unhandled rejection (Node 22+ terminates the process).
  promise.catch((error) => {
    if (timedOut) {
      console.error(`[capabilities] ${label} rejected after timeout: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return Promise.race([promise, timeoutPromise]);
}