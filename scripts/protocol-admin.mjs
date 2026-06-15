#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const defaultDbPath = '.gorombo/db/protocols.sqlite';
const dbPath = process.env.GOROMBO_PROTOCOL_DB_PATH ?? defaultDbPath;
const resolvedDbPath = isAbsolute(dbPath) ? dbPath : resolve(process.cwd(), dbPath);

const command = process.argv[2];
const args = process.argv.slice(3);

const schemaSql = `
CREATE TABLE IF NOT EXISTS protocols (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('base', 'user')),
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  selector_json TEXT NOT NULL,
  rules_json TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'sqlite',
  tags TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_protocols_enabled_priority
  ON protocols(enabled, priority DESC);
`;

function openDatabase() {
  mkdirSync(dirname(resolvedDbPath), { recursive: true });
  const database = new DatabaseSync(resolvedDbPath, { timeout: 5_000 });
  database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
  database.exec(schemaSql);
  try {
    database.exec('ALTER TABLE protocols ADD COLUMN tags TEXT');
  } catch (error) {
    if (!isDuplicateColumnError(error)) {
      throw error;
    }
  }
  return database;
}

function list(database) {
  const rows = database
    .prepare(
      `SELECT id, name, description, scope, enabled, priority, selector_json, rules_json, source, tags
       FROM protocols
       ORDER BY priority DESC, id ASC`,
    )
    .all();
  console.log(JSON.stringify(rows.map(rowToProtocol), null, 2));
}

function seed(database) {
  const seeds = [
    {
      id: 'global.protocols-first',
      name: 'Protocols First',
      description: 'The orchestrator must load protocols before tool use, delegation, or final response.',
      scope: 'base',
      enabled: 1,
      priority: 100,
      selector_json: '{}',
      rules_json: JSON.stringify([
        'Load applicable protocols before final reasoning.',
        'Treat protocols as runtime directives, not skills.',
        'Pass loaded protocol directives to delegated workers when they govern the task.',
      ]),
      source: 'seed',
      tags: null,
    },
    {
      id: 'orchestrator.delegate-only',
      name: 'Orchestrator Delegation',
      description: 'The main orchestrator coordinates; substantive work is delegated to specialized workers.',
      scope: 'base',
      enabled: 1,
      priority: 90,
      selector_json: '{}',
      rules_json: JSON.stringify([
        'The orchestrator does not perform web research, coding, or substantive execution directly.',
        'Delegate research to the researcher worker.',
        'Delegate coding tasks to the coding-worker lead only.',
      ]),
      source: 'seed',
      tags: null,
    },
    {
      id: 'chat.basic-safe-response',
      name: 'Basic Safe Chat Response',
      description: 'Default chat routing rule for normalized message events.',
      scope: 'base',
      enabled: 1,
      priority: 10,
      selector_json: JSON.stringify({ messageKind: 'chat.message' }),
      rules_json: JSON.stringify(['Return a structured response even when all external tools are placeholders.']),
      source: 'seed',
      tags: JSON.stringify(['chat']),
    },
    {
      id: 'coding.use-coding-worker',
      name: 'Coding Worker Delegation',
      description: 'Coding work is owned by the coding-worker lead.',
      scope: 'base',
      enabled: 1,
      priority: 80,
      selector_json: JSON.stringify({ workflow: 'coding' }),
      rules_json: JSON.stringify([
        'Delegate all coding work to the coding-worker lead only.',
        'Never invoke coding-worker internal subagents directly from the orchestrator.',
      ]),
      source: 'seed',
      tags: JSON.stringify(['coding', 'delegation']),
    },
    {
      id: 'coding.required-loop',
      name: 'Coding Worker Required Loop',
      description: 'Mandatory stages for a coding task.',
      scope: 'base',
      enabled: 1,
      priority: 70,
      selector_json: JSON.stringify({ workflow: 'coding' }),
      rules_json: JSON.stringify([
        'Run triage before implementation.',
        'Produce and follow a written plan before editing files.',
        'Run required verification before claiming completion.',
        'Run code review before finalizing mutating side effects.',
      ]),
      source: 'seed',
      tags: JSON.stringify(['coding', 'workflow']),
    },
    {
      id: 'coding.verify-before-complete',
      name: 'Verification Before Completion',
      description: 'The coding worker must verify before claiming success.',
      scope: 'base',
      enabled: 1,
      priority: 70,
      selector_json: JSON.stringify({ workflow: 'coding' }),
      rules_json: JSON.stringify([
        'Do not declare a coding task complete without passing required verification commands.',
        'If verification fails, debug and retry up to the configured replan budget.',
      ]),
      source: 'seed',
      tags: JSON.stringify(['coding', 'verification']),
    },
    {
      id: 'coding.mutating-actions-require-approval',
      name: 'Approval-Gated Mutations',
      description: 'All mutating side effects require explicit human approval.',
      scope: 'base',
      enabled: 1,
      priority: 80,
      selector_json: JSON.stringify({ workflow: 'coding' }),
      rules_json: JSON.stringify([
        'File edits require an explicit file.edit approval record.',
        'Git commit, push, and PR creation require explicit approval records.',
        'The model cannot approve its own requests.',
      ]),
      source: 'seed',
      tags: JSON.stringify(['coding', 'approval', 'safety']),
    },
    {
      id: 'coding.emit-progress',
      name: 'Coding Progress Visibility',
      description: 'The coding worker must surface progress events at every checkpoint.',
      scope: 'base',
      enabled: 1,
      priority: 60,
      selector_json: JSON.stringify({ workflow: 'coding' }),
      rules_json: JSON.stringify([
        'Emit public progress events at every loop checkpoint: plan, edits, verification, approval, PR.',
        'Do not behave like a black box.',
      ]),
      source: 'seed',
      tags: JSON.stringify(['coding', 'progress']),
    },
    {
      id: 'coding.output-report',
      name: 'Coding Completion Report',
      description: 'Required output format for a completed coding task.',
      scope: 'base',
      enabled: 1,
      priority: 50,
      selector_json: JSON.stringify({ workflow: 'coding', task: 'code-change' }),
      rules_json: JSON.stringify([
        'Report files created and modified.',
        'Report verification commands run and their results.',
        'Report any approvals requested or received.',
        'State the next recommended step.',
      ]),
      source: 'seed',
      tags: JSON.stringify(['coding', 'output']),
    },
  ];

  const insert = database.prepare(
    `INSERT OR IGNORE INTO protocols
     (id, name, description, scope, enabled, priority, selector_json, rules_json, source, tags, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const protocol of seeds) {
    insert.run(
      protocol.id,
      protocol.name,
      protocol.description,
      protocol.scope,
      protocol.enabled,
      protocol.priority,
      protocol.selector_json,
      protocol.rules_json,
      protocol.source,
      protocol.tags,
      new Date().toISOString(),
      new Date().toISOString(),
    );
  }

  console.log(`Seeded ${seeds.length} base protocols.`);
}

function add(database, argv) {
  const id = argv[0];
  const name = argv[1];
  const description = argv[2] ?? '';
  const priority = Number(argv[3] ?? 0);
  const rules = argv.slice(4).length > 0 ? argv.slice(4) : [];

  if (!id || !name) {
    console.error('Usage: protocol-admin.mjs add <id> <name> [description] [priority] [rule...]');
    process.exit(1);
  }

  database
    .prepare(
      `INSERT INTO protocols
       (id, name, description, scope, enabled, priority, selector_json, rules_json, source, tags, created_at, updated_at)
       VALUES (?, ?, ?, 'user', 1, ?, ?, ?, 'sqlite', NULL, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         description = excluded.description,
         scope = excluded.scope,
         enabled = excluded.enabled,
         priority = excluded.priority,
         selector_json = excluded.selector_json,
         rules_json = excluded.rules_json,
         source = excluded.source,
         tags = excluded.tags,
         updated_at = excluded.updated_at`,
    )
    .run(id, name, description, priority, '{}', JSON.stringify(rules), new Date().toISOString(), new Date().toISOString());

  console.log(`Added/updated user protocol ${id}.`);
}

function remove(database, argv) {
  const id = argv[0];
  if (!id) {
    console.error('Usage: protocol-admin.mjs remove <id>');
    process.exit(1);
  }

  const existing = database.prepare(`SELECT scope FROM protocols WHERE id = ?`).get(id);
  if (existing && existing.scope === 'base') {
    console.error(`Cannot remove base protocol ${id}.`);
    process.exit(1);
  }

  const result = database.prepare(`DELETE FROM protocols WHERE id = ? AND scope = 'user'`).run(id);
  if (result.changes > 0) {
    console.log(`Removed user protocol ${id}.`);
  } else {
    console.log(`No user protocol found for ${id}.`);
  }
}

function setEnabled(database, argv, enabled) {
  const id = argv[0];
  if (!id) {
    console.error(`Usage: protocol-admin.mjs ${enabled ? 'enable' : 'disable'} <id>`);
    process.exit(1);
  }

  const existing = database.prepare(`SELECT scope FROM protocols WHERE id = ?`).get(id);
  if (existing && existing.scope === 'base') {
    console.error(`Cannot ${enabled ? 'enable' : 'disable'} base protocol ${id}.`);
    process.exit(1);
  }

  const result = database
    .prepare(`UPDATE protocols SET enabled = ?, updated_at = ? WHERE id = ? AND scope = 'user'`)
    .run(enabled ? 1 : 0, new Date().toISOString(), id);

  if (result.changes > 0) {
    console.log(`${enabled ? 'Enabled' : 'Disabled'} protocol ${id}.`);
  } else {
    console.log(`No protocol found for ${id}.`);
  }
}

function rowToProtocol(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    scope: row.scope,
    enabled: Boolean(row.enabled),
    priority: row.priority,
    appliesTo: parseJsonObject(row.selector_json),
    rules: parseJsonStringArray(row.rules_json),
    source: row.source,
    tags: row.tags ? parseJsonStringArray(row.tags) : undefined,
  };
}

function parseJsonObject(value) {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function parseJsonStringArray(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function isDuplicateColumnError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /\bduplicate column\b/i.test(message);
}

function showHelp() {
  console.log(`Usage: protocol-admin.mjs <command> [args]

Commands:
  seed                          Create tables and seed base protocols.
  list                          List all protocols.
  add <id> <name> [desc] [priority] [rule...]
                                Add or overwrite a user protocol.
  remove <id>                  Remove a user protocol.
  enable <id>                  Enable a protocol.
  disable <id>                 Disable a protocol.

Environment:
  GOROMBO_PROTOCOL_DB_PATH      Path to the SQLite database (default: ${defaultDbPath})
`);
}

const database = openDatabase();

try {
  switch (command) {
    case 'seed':
      seed(database);
      break;
    case 'list':
      list(database);
      break;
    case 'add':
      add(database, args);
      break;
    case 'remove':
      remove(database, args);
      break;
    case 'enable':
      setEnabled(database, args, true);
      break;
    case 'disable':
      setEnabled(database, args, false);
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
