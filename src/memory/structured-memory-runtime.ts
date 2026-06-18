import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { goromboPersistenceRuntime } from '../db.js';
import type { GoromboConfig } from '../config/gorombo-config.js';
import type {
  AddChecklistItemInput,
  Checklist,
  CreateChecklistInput,
  CreateSessionNoteInput,
  CreateTodoInput,
  DeleteInput,
  MemoryRecord,
  MemoryRecordSnapshot,
  QueryInput,
  SessionNote,
  Todo,
  UpdateChecklistInput,
  UpdateChecklistItemInput,
  UpdateSessionNoteInput,
  UpdateTodoInput,
} from '../types/memory.js';
import type { MemoryEngine } from './memory-engine.js';
import { ChecklistMemoryProvider } from './checklist-memory-provider.js';
import type { MemoryProvider } from './memory-provider.js';
import {
  GoromboStructuredMemoryDatabase,
  defaultStructuredMemoryDatabasePath,
} from './structured-memory-database.js';
import { InMemoryMemoryEngine, RustMemoryEngine } from './rust-memory-engine.js';
import { StructuredMemoryNoteIndex } from './structured-memory-note-index.js';

/** Runtime config for the structured-memory subsystem (plan §Configuration). */
export interface GoromboMemoryConfig {
  enabled?: boolean;
  backend?: 'sqlite' | 'lancedb' | 'memory';
  sqlitePath?: string;
  /** WASM module path (the generated `gorombo_memory.js`). Dev default: crates/gorombo-memory/pkg. */
  wasmModulePath?: string;
  expectedVersion?: string;
  defaultLimit?: number;
  maxContextTokens?: number;
  enableSemanticNotes?: boolean;
  retentionDays?: number;
  archiveDeleteDays?: number;
  maxChecklistDepth?: number;
}

const DEFAULTS: Required<Omit<GoromboMemoryConfig, 'sqlitePath' | 'wasmModulePath' | 'expectedVersion'>> = {
  enabled: true,
  backend: 'sqlite',
  defaultLimit: 10,
  maxContextTokens: 1_500,
  enableSemanticNotes: true,
  retentionDays: 30,
  archiveDeleteDays: 365,
  maxChecklistDepth: 5,
};

const WASM_VERSION = '0.1.0';

const DEV_WASM_MODULE_PATH = resolve(
  process.cwd(),
  'crates',
  'gorombo-memory',
  'pkg',
  'gorombo_memory.js',
);
const DIST_WASM_MODULE_PATH = resolve(process.cwd(), 'dist', 'memory', 'gorombo_memory.js');

export interface StructuredMemoryRuntime {
  engine: MemoryEngine;
  database: GoromboStructuredMemoryDatabase;
  provider: MemoryProvider;
  config: GoromboMemoryConfig;
}

let runtimePromise: Promise<StructuredMemoryRuntime> | undefined;

/** Resolve the typed memory config block from the raw `GoromboConfig.memory` record. */
export function resolveMemoryConfig(raw: Record<string, unknown> | undefined, env: Record<string, string | undefined> = process.env): GoromboMemoryConfig {
  const fromEnv = readMemoryEnvOverrides(env);
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULTS, ...fromEnv };
  }
  const readNum = (key: string, def: number): number =>
    typeof raw[key] === 'number' && Number.isFinite(raw[key] as number) ? (raw[key] as number) : def;
  const readBool = (key: string, def: boolean): boolean =>
    typeof raw[key] === 'boolean' ? (raw[key] as boolean) : def;
  return {
    ...DEFAULTS,
    ...(raw.enabled !== undefined ? { enabled: readBool('enabled', true) } : {}),
    backend: (raw.backend as GoromboMemoryConfig['backend']) ?? 'sqlite',
    ...(typeof raw.sqlitePath === 'string' ? { sqlitePath: raw.sqlitePath } : {}),
    ...(typeof raw.wasmModulePath === 'string' ? { wasmModulePath: raw.wasmModulePath } : {}),
    ...(typeof raw.expectedVersion === 'string' ? { expectedVersion: raw.expectedVersion } : {}),
    defaultLimit: readNum('defaultLimit', DEFAULTS.defaultLimit),
    maxContextTokens: readNum('maxContextTokens', DEFAULTS.maxContextTokens),
    enableSemanticNotes: readBool('enableSemanticNotes', DEFAULTS.enableSemanticNotes),
    retentionDays: readNum('retentionDays', DEFAULTS.retentionDays),
    archiveDeleteDays: readNum('archiveDeleteDays', DEFAULTS.archiveDeleteDays),
    maxChecklistDepth: readNum('maxChecklistDepth', DEFAULTS.maxChecklistDepth),
    // Environment variables take precedence over the JSON config.
    ...fromEnv,
  };
}

/** Read the GOROMBO_MEMORY_* env overrides. Env wins over JSON config. */
export function readMemoryEnvOverrides(env: Record<string, string | undefined>): Partial<GoromboMemoryConfig> {
  const out: Partial<GoromboMemoryConfig> = {};
  const backend = env.GOROMBO_MEMORY_BACKEND;
  if (backend === 'sqlite' || backend === 'lancedb' || backend === 'memory') {
    out.backend = backend;
  }
  if (typeof env.GOROMBO_MEMORY_SQLITE_PATH === 'string' && env.GOROMBO_MEMORY_SQLITE_PATH) {
    out.sqlitePath = env.GOROMBO_MEMORY_SQLITE_PATH;
  }
  const num = (key: string): number | undefined => {
    const v = env[key];
    if (typeof v !== 'string' || !v) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const dl = num('GOROMBO_MEMORY_DEFAULT_LIMIT'); if (dl !== undefined) out.defaultLimit = dl;
  const mct = num('GOROMBO_MEMORY_MAX_CONTEXT_TOKENS'); if (mct !== undefined) out.maxContextTokens = mct;
  const rd = num('GOROMBO_MEMORY_RETENTION_DAYS'); if (rd !== undefined) out.retentionDays = rd;
  const add = num('GOROMBO_MEMORY_ARCHIVE_DELETE_DAYS'); if (add !== undefined) out.archiveDeleteDays = add;
  const mcd = num('GOROMBO_MEMORY_MAX_CHECKLIST_DEPTH'); if (mcd !== undefined) out.maxChecklistDepth = mcd;
  return out;
}

/**
 * Lazily-initialized structured-memory runtime singleton. Loads the WASM
 * engine (falling back to the pure-TS `InMemoryMemoryEngine` when the artifact
 * is absent), runs the cleanup job, hydrates the engine from SQLite, and wraps
 * mutations so every create/update/delete is persisted to the durable store.
 */
export function getStructuredMemoryRuntime(config?: GoromboConfig): Promise<StructuredMemoryRuntime> {
  if (!runtimePromise) {
    runtimePromise = createStructuredMemoryRuntime(config);
  }
  return runtimePromise;
}

/** Reset the singleton (test helper). */
export function resetStructuredMemoryRuntime(): void {
  runtimePromise = undefined;
}

async function createStructuredMemoryRuntime(config?: GoromboConfig): Promise<StructuredMemoryRuntime> {
  const memConfig = resolveMemoryConfig(config?.memory as Record<string, unknown> | undefined);

  const database = new GoromboStructuredMemoryDatabase({
    filePath: memConfig.sqlitePath ?? defaultStructuredMemoryDatabasePath,
  });

  // Cold-start cleanup runs before hydration so the engine never sees
  // records that should already be gone.
  database.cleanupExpired(memConfig.retentionDays ?? 0, memConfig.archiveDeleteDays ?? 0);

  const baseEngine = await loadEngine(memConfig);
  const records = database.loadAllRecords();
  const snapshot: MemoryRecordSnapshot = { records };
  await baseEngine.reconcile(snapshot, memConfig.maxChecklistDepth);

  const noteIndex = memConfig.enableSemanticNotes
    ? new StructuredMemoryNoteIndex({
        vectorStore: goromboPersistenceRuntime.vectorStore,
        embeddingClient: goromboPersistenceRuntime.embeddingClient as never,
      })
    : undefined;
  const engine = new PersistingMemoryEngine(baseEngine, database, noteIndex);
  const provider = new ChecklistMemoryProvider({
    engineLoader: () => Promise.resolve(engine),
    maxContextTokens: memConfig.maxContextTokens,
    defaultLimit: memConfig.defaultLimit,
    noteIndex,
  });

  return { engine, database, provider, config: memConfig };
}

async function loadEngine(memConfig: GoromboMemoryConfig): Promise<MemoryEngine> {
  if (memConfig.backend === 'memory') {
    return new InMemoryMemoryEngine();
  }
  // In test mode, prefer the in-memory engine unless a WASM path is explicitly
  // configured. This keeps the shared WASM thread_local store out of the
  // concurrently-run unit-test process (the WASM engine is covered directly
  // by src/tests/rust-memory-engine.test.ts and `cargo test`).
  if (process.env.GOROMBO_TEST_MODE === '1' && !memConfig.wasmModulePath) {
    return new InMemoryMemoryEngine();
  }
  const candidatePaths = [
    memConfig.wasmModulePath,
    DEV_WASM_MODULE_PATH,
    DIST_WASM_MODULE_PATH,
  ].filter((p): p is string => typeof p === 'string');
  for (const wasmModulePath of candidatePaths) {
    if (!existsSync(wasmModulePath)) {
      continue;
    }
    try {
      return await RustMemoryEngine.load({
        wasmModulePath,
        expectedVersion: memConfig.expectedVersion ?? WASM_VERSION,
        maxChecklistDepth: memConfig.maxChecklistDepth,
      });
    } catch (error) {
      console.error(
        '[WARN] gorombo-memory WASM engine failed to load, falling back to in-memory engine:',
        error instanceof Error ? error.message : String(error),
      );
      break;
    }
  }
  console.error('[WARN] gorombo-memory WASM artifact not found; structured-memory using in-memory engine.');
  return new InMemoryMemoryEngine();
}

/**
 * Engine decorator that persists every mutation to the durable SQLite store.
 * Reads (`query`, `version`, `reconcile`) delegate to the underlying engine.
 */
class PersistingMemoryEngine implements MemoryEngine {
  constructor(
    private readonly inner: MemoryEngine,
    private readonly database: GoromboStructuredMemoryDatabase,
    private readonly noteIndex?: StructuredMemoryNoteIndex,
  ) {}

  version(): Promise<string> {
    return this.inner.version();
  }

  async createChecklist(input: CreateChecklistInput): Promise<Checklist> {
    const record = await this.inner.createChecklist(input);
    this.database.writeRecord(record);
    return record;
  }

  async updateChecklist(input: UpdateChecklistInput): Promise<Checklist> {
    const record = await this.inner.updateChecklist(input);
    this.database.writeRecord(record);
    return record;
  }

  async addChecklistItem(input: AddChecklistItemInput): Promise<Checklist> {
    const record = await this.inner.addChecklistItem(input);
    this.database.writeRecord(record);
    return record;
  }

  async updateChecklistItem(input: UpdateChecklistItemInput): Promise<Checklist> {
    const record = await this.inner.updateChecklistItem(input);
    this.database.writeRecord(record);
    return record;
  }

  async createTodo(input: CreateTodoInput): Promise<Todo> {
    const record = await this.inner.createTodo(input);
    this.database.writeRecord(record);
    return record;
  }

  async updateTodo(input: UpdateTodoInput): Promise<Todo> {
    const record = await this.inner.updateTodo(input);
    this.database.writeRecord(record);
    return record;
  }

  async createSessionNote(input: CreateSessionNoteInput): Promise<SessionNote> {
    const record = await this.inner.createSessionNote(input);
    this.database.writeRecord(record);
    await this.noteIndex?.upsertNote(record);
    return record;
  }

  async updateSessionNote(input: UpdateSessionNoteInput): Promise<SessionNote> {
    const record = await this.inner.updateSessionNote(input);
    this.database.writeRecord(record);
    if (record.status === 'archived') {
      await this.noteIndex?.deleteNote(record.id);
    } else {
      await this.noteIndex?.upsertNote(record);
    }
    return record;
  }

  query(input: QueryInput): Promise<MemoryRecord[]> {
    return this.inner.query(input);
  }

  async delete(input: DeleteInput): Promise<void> {
    await this.inner.delete(input);
    this.database.deleteRecord(input.id);
    await this.noteIndex?.deleteNote(input.id);
  }

  async reconcile(snapshot: MemoryRecordSnapshot, maxChecklistDepth?: number): Promise<void> {
    await this.inner.reconcile(snapshot, maxChecklistDepth);
  }
}

/** Convenience accessor used by tools (Phase 3) and the retrieve_memory wiring. */
export async function getStructuredMemoryEngine(config?: GoromboConfig): Promise<MemoryEngine> {
  return (await getStructuredMemoryRuntime(config)).engine;
}

export { goromboPersistenceRuntime };
