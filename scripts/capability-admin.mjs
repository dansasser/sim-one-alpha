#!/usr/bin/env node
import { mkdirSync, existsSync, rmSync, cpSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execSync } from 'node:child_process';

const defaultDbPath = '.gorombo/db/capabilities.sqlite';
const dbPath = process.env.GOROMBO_CAPABILITY_DB_PATH ?? defaultDbPath;
const resolvedDbPath = isAbsolute(dbPath) ? dbPath : resolve(process.cwd(), dbPath);

const command = process.argv[2];
const kind = process.argv[3];
const args = process.argv.slice(4);

const schemaSql = `
CREATE TABLE IF NOT EXISTS capabilities (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('skill', 'tool', 'worker', 'mcp')),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('github', 'local', 'npm', 'builtin')),
  source_ref TEXT NOT NULL,
  version TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  config_json TEXT NOT NULL DEFAULT '{}',
  installed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  installed_by TEXT NOT NULL DEFAULT 'cli'
);

CREATE INDEX IF NOT EXISTS idx_capabilities_kind_enabled
  ON capabilities(kind, enabled);
`;

function openDatabase() {
  mkdirSync(dirname(resolvedDbPath), { recursive: true });
  const database = new DatabaseSync(resolvedDbPath, { timeout: 5_000 });
  database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
  database.exec(schemaSql);
  return database;
}

const VALID_KINDS = ['skill', 'tool', 'worker', 'mcp'];

function isValidKind(value) {
  return VALID_KINDS.includes(value);
}

function getCapabilitiesDir() {
  const configured = process.env.GOROMBO_CAPABILITIES_DIR ?? process.env.GOROMBO_CAPABILITY_DIR;
  if (configured) {
    return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
  }
  return resolve(process.cwd(), '.gorombo', 'capabilities');
}

function getCapabilityPath(kind, id) {
  return resolve(getCapabilitiesDir(), kind + 's', id);
}

function fetchSource(sourceRef, kind, id) {
  const targetPath = getCapabilityPath(kind, id);
  mkdirSync(dirname(targetPath), { recursive: true });

  if (existsSync(targetPath)) {
    rmSync(targetPath, { recursive: true, force: true });
  }

  if (sourceRef.startsWith('http://') || sourceRef.startsWith('https://') || sourceRef.startsWith('git@')) {
    execSync(`git clone --depth 1 ${shellQuote(sourceRef)} ${shellQuote(targetPath)}`, {
      stdio: 'pipe',
      timeout: 30_000,
    });
    rmSync(resolve(targetPath, '.git'), { recursive: true, force: true });
    return { source: 'github', path: targetPath };
  }

  if (existsSync(sourceRef)) {
    const absSource = isAbsolute(sourceRef) ? sourceRef : resolve(process.cwd(), sourceRef);
    cpSync(absSource, targetPath, { recursive: true, force: true });
    return { source: 'local', path: targetPath };
  }

  throw new Error(`Cannot resolve source: ${sourceRef}`);
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function addCapability(database, kind, args) {
  let id, name, description, sourceRef, source, configJson, enableFlag, versionArg;

  if (kind === 'mcp') {
    // MCP: add mcp <id> <name> [description] --url <url> [--transport <t>] [--token-env <ENV>] [--enable]
    id = args[0];
    name = args[1];
    description = args[2] && !args[2].startsWith('--') ? args[2] : '';
    sourceRef = `mcp://${id}`;
    source = 'local';
    const urlArg = extractFlag(args, '--url');
    const transportArg = extractFlag(args, '--transport') ?? 'streamable-http';
    const tokenEnvArg = extractFlag(args, '--token-env');
    enableFlag = args.includes('--enable');
    if (!id || !name || !urlArg) {
      console.error(`Usage: capability-admin.mjs add mcp <id> <name> [description] --url <url> [--transport <streamable-http|sse>] [--token-env <ENV_VAR>] [--enable]`);
      process.exit(1);
    }
    configJson = JSON.stringify({ mcpUrl: urlArg, mcpTransport: transportArg, mcpTokenEnv: tokenEnvArg ?? undefined });
  } else {
    // skill/tool/worker: add <kind> <github-url|local-path> <id> <name> [description] [--enable] [--version <ver>]
    [sourceRef, id, name] = args;
    const rest = args.slice(3);
    description = rest.find(a => !a.startsWith('--')) ?? '';
    enableFlag = args.includes('--enable');
    versionArg = extractFlag(args, '--version');
    if (!sourceRef || !id || !name) {
      console.error(`Usage: capability-admin.mjs add ${kind} <github-url|local-path> <id> <name> [description] [--enable] [--version <ver>]`);
      process.exit(1);
    }
    configJson = '{}';
    const fetched = fetchSource(sourceRef, kind, id);
    source = fetched.source;
  }

  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO capabilities
       (id, kind, name, description, source, source_ref, version, enabled, config_json, installed_at, updated_at, installed_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'cli')
       ON CONFLICT(id) DO UPDATE SET
         kind = excluded.kind, name = excluded.name, description = excluded.description,
         source = excluded.source, source_ref = excluded.source_ref, version = excluded.version,
         enabled = excluded.enabled, config_json = excluded.config_json, updated_at = excluded.updated_at`,
    )
    .run(id, kind, name, description, source, sourceRef, versionArg ?? null, enableFlag ? 1 : 0, configJson, now, now);

  console.log(`Added ${kind} capability ${id}. ${enableFlag ? 'Enabled.' : 'Disabled — run `capability-admin.mjs enable ' + kind + ' ' + id + '` to activate.'}`);
}

function extractFlag(args, flagName) {
  const index = args.indexOf(flagName);
  if (index === -1 || index + 1 >= args.length) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

function listCapabilities(database, kind) {
  let sql = 'SELECT * FROM capabilities';
  const params = [];
  if (kind && isValidKind(kind)) {
    sql += ' WHERE kind = ?';
    params.push(kind);
  }
  sql += ' ORDER BY kind ASC, id ASC';
  const rows = database.prepare(sql).all(...params);
  const formatted = rows.map(rowToCapability);
  console.log(JSON.stringify(formatted, null, 2));
}

function enableCapability(database, kind, args) {
  const id = args[0];
  if (!id) {
    console.error(`Usage: capability-admin.mjs enable ${kind} <id>`);
    process.exit(1);
  }
  const result = database.prepare('UPDATE capabilities SET enabled = 1, updated_at = ? WHERE id = ? AND kind = ?').run(new Date().toISOString(), id, kind);
  if (result.changes > 0) {
    console.log(`Enabled ${kind} ${id}.`);
  } else {
    console.log(`No ${kind} capability found for ${id}.`);
  }
}

function disableCapability(database, kind, args) {
  const id = args[0];
  if (!id) {
    console.error(`Usage: capability-admin.mjs disable ${kind} <id>`);
    process.exit(1);
  }
  const result = database.prepare('UPDATE capabilities SET enabled = 0, updated_at = ? WHERE id = ? AND kind = ?').run(new Date().toISOString(), id, kind);
  if (result.changes > 0) {
    console.log(`Disabled ${kind} ${id}.`);
  } else {
    console.log(`No ${kind} capability found for ${id}.`);
  }
}

function removeCapability(database, kind, args) {
  const id = args[0];
  if (!id) {
    console.error(`Usage: capability-admin.mjs remove ${kind} <id>`);
    process.exit(1);
  }
  if (kind !== 'mcp') {
    const capPath = getCapabilityPath(kind, id);
    if (existsSync(capPath)) {
      rmSync(capPath, { recursive: true, force: true });
    }
  }
  const result = database.prepare('DELETE FROM capabilities WHERE id = ? AND kind = ?').run(id, kind);
  if (result.changes > 0) {
    console.log(`Removed ${kind} ${id}.`);
  } else {
    console.log(`No ${kind} capability found for ${id}.`);
  }
}

function updateCapability(database, kind, args) {
  const id = args[0];
  if (!id) {
    console.error(`Usage: capability-admin.mjs update ${kind} <id>`);
    process.exit(1);
  }
  const row = database.prepare('SELECT source_ref FROM capabilities WHERE id = ? AND kind = ?').get(id, kind);
  if (!row) {
    console.log(`No ${kind} capability found for ${id}.`);
    return;
  }
  const sourceRef = String(row.source_ref);
  if (kind !== 'mcp') {
    const targetPath = getCapabilityPath(kind, id);
    if (existsSync(targetPath)) {
      rmSync(targetPath, { recursive: true, force: true });
    }
    if (sourceRef.startsWith('http') || sourceRef.startsWith('git@')) {
      execSync(`git clone --depth 1 ${shellQuote(sourceRef)} ${shellQuote(targetPath)}`, { stdio: 'pipe', timeout: 30_000 });
      rmSync(resolve(targetPath, '.git'), { recursive: true, force: true });
      console.log(`Updated ${kind} ${id} from GitHub.`);
    } else if (existsSync(sourceRef)) {
      const absSource = isAbsolute(sourceRef) ? sourceRef : resolve(process.cwd(), sourceRef);
      cpSync(absSource, targetPath, { recursive: true, force: true });
      console.log(`Updated ${kind} ${id} from local path.`);
    } else {
      console.log(`Source not found: ${sourceRef}`);
    }
  } else {
    database.prepare('UPDATE capabilities SET updated_at = ? WHERE id = ? AND kind = ?').run(new Date().toISOString(), id, kind);
    console.log(`Updated ${kind} ${id} metadata.`);
  }
}

function rowToCapability(row) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    description: row.description,
    source: row.source,
    sourceRef: row.source_ref,
    version: row.version ?? null,
    enabled: Boolean(row.enabled),
    config: JSON.parse(row.config_json ?? '{}'),
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
    installedBy: row.installed_by,
  };
}

function showHelp() {
  console.log(`Usage: capability-admin.mjs <command> <kind> [args]

Kinds: skill, tool, worker, mcp

Commands:
  add <kind> <github-url|local-path> <id> <name> [description] [--enable] [--version <ver>]
        Add or overwrite a capability. For mcp: add mcp <id> <name> --url <url> [--transport <t>] [--token-env <ENV>] [--enable]
  list [kind]
        List all capabilities, or filtered by kind.
  enable <kind> <id>
        Enable a capability.
  disable <kind> <id>
        Disable a capability.
  remove <kind> <id>
        Remove a capability and delete its files.
  update <kind> <id>
        Re-fetch from source (github pull or local copy).

Environment:
  GOROMBO_CAPABILITY_DB_PATH   Path to SQLite database (default: ${defaultDbPath})
  GOROMBO_CAPABILITIES_DIR     Path to capability files (default: .gorombo/capabilities/)
`);
}

const database = openDatabase();

try {
  switch (command) {
    case 'add':
      if (!isValidKind(kind)) { console.error(`Invalid kind: ${kind}. Valid: ${VALID_KINDS.join(', ')}`); process.exit(1); }
      addCapability(database, kind, args);
      break;
    case 'list':
      listCapabilities(database, kind);
      break;
    case 'enable':
      if (!isValidKind(kind)) { console.error(`Invalid kind: ${kind}`); process.exit(1); }
      enableCapability(database, kind, args);
      break;
    case 'disable':
      if (!isValidKind(kind)) { console.error(`Invalid kind: ${kind}`); process.exit(1); }
      disableCapability(database, kind, args);
      break;
    case 'remove':
      if (!isValidKind(kind)) { console.error(`Invalid kind: ${kind}`); process.exit(1); }
      removeCapability(database, kind, args);
      break;
    case 'update':
      if (!isValidKind(kind)) { console.error(`Invalid kind: ${kind}`); process.exit(1); }
      updateCapability(database, kind, args);
      break;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      showHelp();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      showHelp();
      process.exit(1);
  }
} finally {
  database.close();
}