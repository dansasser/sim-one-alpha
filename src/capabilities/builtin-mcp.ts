import { connectMcpServer, type McpServerConnection, type ToolDefinition } from '@flue/runtime';

export const BUILTIN_MCP_ASTRO_DOCS_ID = 'astro-docs';
const ASTRO_DOCS_URL = 'https://mcp.docs.astro.build/mcp';

export interface BuiltinMcpResult {
  tools: ToolDefinition[];
  connections: McpServerConnection[];
}

export async function connectBuiltinMcpServers(): Promise<BuiltinMcpResult> {
  const connections: McpServerConnection[] = [];
  const allTools: ToolDefinition[] = [];

  try {
    const connection = await withTimeout(
      connectMcpServer(BUILTIN_MCP_ASTRO_DOCS_ID, {
        url: ASTRO_DOCS_URL,
        transport: 'streamable-http',
        timeoutMs: 10_000,
      }),
      15_000,
      `MCP connect ${BUILTIN_MCP_ASTRO_DOCS_ID}`,
    );
    connections.push(connection);
    allTools.push(...connection.tools);
    console.log(`[capabilities] Built-in MCP connected: ${BUILTIN_MCP_ASTRO_DOCS_ID} (${connection.tools.length} tools)`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[capabilities] Built-in MCP connection failed for ${BUILTIN_MCP_ASTRO_DOCS_ID}: ${message}`);
  }

  return { tools: allTools, connections };
}

export function getBuiltinMcpIds(): string[] {
  return [BUILTIN_MCP_ASTRO_DOCS_ID];
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}