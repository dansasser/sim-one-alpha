import {
  checkNameCollision,
} from '../../../src/capabilities/index.js';
import type {
  CapabilityConfig,
  CapabilityRecord,
} from '../../../src/capabilities/index.js';
import { assertSafeCapabilityId, withStore } from './store.js';

const KIND = 'mcp' as const;

/**
 * Add (or overwrite) an MCP capability. MCP capabilities are not materialized
 * on disk — they are a SQLite row pointing at a remote MCP server via
 * `mcpUrl`, `mcpTransport`, and an optional `mcpTokenEnv` env-var name.
 *
 * MCP capabilities default to disabled unless `--enable` is requested.
 */
export function addMcp(
  id: string,
  name: string,
  url: string,
  description = '',
  transport: 'streamable-http' | 'sse' = 'streamable-http',
  tokenEnv?: string,
  enable = false,
): void {
  assertSafeCapabilityId(id);

  try {
    new URL(url);
  } catch {
    console.error(`Error: Invalid URL '${url}'. Must be a valid HTTP(S) URL.`);
    process.exit(1);
  }

  if (transport !== 'streamable-http' && transport !== 'sse') {
    console.error(`Error: Invalid transport '${transport}'. Must be 'streamable-http' or 'sse'.`);
    process.exit(1);
  }

  const collision = checkNameCollision(KIND, id);
  if (collision.collision) {
    console.error(`Error: ${collision.message}`);
    process.exit(1);
  }

  const config: CapabilityConfig = {
    mcpUrl: url,
    mcpTransport: transport,
    mcpTokenEnv: tokenEnv,
  };
  const now = new Date().toISOString();
  const record: CapabilityRecord = {
    id,
    kind: KIND,
    name,
    description,
    source: 'local',
    sourceRef: `mcp://${id}`,
    version: null,
    enabled: enable,
    config,
    installedAt: now,
    updatedAt: now,
    installedBy: 'cli',
  };

  withStore((store) => {
    store.insert(record);
    console.log(
      `Added mcp capability ${id}. ${enable ? 'Enabled.' : `Disabled — run \`sim-one mcp enable ${id}\` to activate.`}`,
    );
  });
}

/**
 * List all MCP capabilities (as JSON).
 */
export function listMcp(): void {
  withStore((store) => {
    const rows = store.list({ kind: KIND });
    console.log(JSON.stringify(rows, null, 2));
  });
}

/**
 * Enable an MCP capability.
 */
export function enableMcp(id: string): void {
  assertSafeCapabilityId(id);
  withStore((store) => {
    const before = store.get(KIND, id);
    store.setEnabled(KIND, id, true);
    console.log(before ? `Enabled mcp ${id}.` : `No mcp capability found for ${id}.`);
  });
}

/**
 * Disable an MCP capability.
 */
export function disableMcp(id: string): void {
  assertSafeCapabilityId(id);
  withStore((store) => {
    const before = store.get(KIND, id);
    store.setEnabled(KIND, id, false);
    console.log(before ? `Disabled mcp ${id}.` : `No mcp capability found for ${id}.`);
  });
}

/**
 * Remove an MCP capability. MCP has no on-disk materialization, so only the
 * SQLite row is deleted.
 */
export function removeMcp(id: string): void {
  assertSafeCapabilityId(id);
  withStore((store) => {
    const removed = store.remove(KIND, id);
    console.log(removed ? `Removed mcp ${id}.` : `No mcp capability found for ${id}.`);
  });
}

/**
 * Update an MCP capability's metadata timestamp. MCP has no source files to
 * re-fetch; `update` simply bumps `updated_at` to signal a refresh.
 */
export function updateMcp(id: string): void {
  assertSafeCapabilityId(id);
  withStore((store) => {
    const record = store.get(KIND, id);
    if (!record) {
      console.log(`No mcp capability found for ${id}.`);
      return;
    }
    store.update(KIND, id, {});
    console.log(`Updated mcp ${id} metadata.`);
  });
}