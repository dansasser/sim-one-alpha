import { defineTool, Type, type ToolDefinition } from '@flue/runtime';
import { join } from 'node:path';
import { evaluateCodingShellCommand } from './command-policy.js';
import {
  createFlueLocalCodingSandbox,
  normalizeRepoRelativePath,
  type CodingSandboxRuntime,
} from './sandbox-runtime.js';
import type { CodingProgressReporter } from '../events/progress-reporter.js';
import type { CodingWorkerEventType } from '../events/coding-worker-events.js';
import type { CodingFileEdit, CodingFileWrite } from '../types.js';
import {
  createProjectRelativePath,
  normalizeProjectSlug,
  resolveCodingWorkspaceTarget,
  type CodingProjectDirectoryKind,
  type CodingWorkspaceTargetInput,
} from '../repo/workspace-target.js';

export interface CodingRepoToolsOptions extends CodingWorkspaceTargetInput {
  env?: Record<string, string | undefined>;
  sandbox?: CodingSandboxRuntime;
  reporter?: CodingProgressReporter;
  taskId?: string;
  sessionId?: string;
}

const defaultIgnoredDirectories = new Set([
  '.git',
  '.tmp',
  'dist',
  'node_modules',
  'coverage',
]);

export function createCodingRepoTools(options: CodingRepoToolsOptions): ToolDefinition[] {
  let sandboxPromise: Promise<CodingSandboxRuntime> | undefined;
  const getSandbox = async () => {
    sandboxPromise ??= options.sandbox
      ? Promise.resolve(options.sandbox)
      : createFlueLocalCodingSandbox({
          workspaceRoot: options.workspaceRoot,
          targetKind: options.targetKind,
          projectId: options.projectId,
          projectSlug: options.projectSlug,
          projectRelativePath: options.projectRelativePath,
          repoPath: options.repoPath,
          env: options.env,
          sessionId: options.sessionId,
        });
    return sandboxPromise;
  };

  return [
    defineTool({
      name: 'coding_repo_list_files',
      description:
        'List files inside the selected coding-worker workspace/project scope. Skips heavy generated directories by default.',
      parameters: Type.Object({
        root: Type.Optional(Type.String()),
        maxFiles: Type.Optional(Type.Number()),
      }),
      execute: async (args) => {
        const sandbox = await getSandbox();
        const files = await listRepoFiles(sandbox, {
          root: readString(args.root) ?? '.',
          maxFiles: readPositiveInteger(args.maxFiles) ?? 500,
        });
        return toToolJson({ files });
      },
    }),
    defineTool({
      name: 'coding_repo_read_file',
      description: 'Read a UTF-8 file inside the selected coding-worker workspace/project scope.',
      parameters: Type.Object({
        path: Type.String(),
      }),
      execute: async (args) => {
        const sandbox = await getSandbox();
        const path = requireString(args.path, 'path');
        const content = await sandbox.readFile(path);
        return toToolJson({
          path: normalizeRepoRelativePath(sandbox.repoPath, path),
          content,
        });
      },
    }),
    defineTool({
      name: 'coding_repo_search',
      description: 'Search UTF-8 files for a literal string inside the selected coding-worker workspace/project scope.',
      parameters: Type.Object({
        query: Type.String(),
        root: Type.Optional(Type.String()),
        maxResults: Type.Optional(Type.Number()),
      }),
      execute: async (args) => {
        const sandbox = await getSandbox();
        const results = await searchRepo(sandbox, {
          query: requireString(args.query, 'query'),
          root: readString(args.root) ?? '.',
          maxResults: readPositiveInteger(args.maxResults) ?? 100,
        });
        return toToolJson({ results });
      },
    }),
    defineTool({
      name: 'coding_repo_write_file',
      description:
        'Write a UTF-8 file inside the selected coding-worker workspace/project scope. Use for complete-file generated outputs or explicit replacements.',
      parameters: Type.Object({
        path: Type.String(),
        content: Type.String(),
      }),
      execute: async (args) => {
        const sandbox = await getSandbox();
        const path = requireString(args.path, 'path');
        await sandbox.writeFile(path, requireString(args.content, 'content'));
        emitToolProgress(options, {
          action: 'write-file',
          summary: `Wrote ${normalizeRepoRelativePath(sandbox.repoPath, path)}.`,
          evidence: [normalizeRepoRelativePath(sandbox.repoPath, path)],
        });
        return toToolJson({
          path: normalizeRepoRelativePath(sandbox.repoPath, path),
          status: 'written',
        });
      },
    }),
    defineTool({
      name: 'coding_repo_apply_patch',
      description:
        'Apply exact text replacements to one UTF-8 file inside the selected coding-worker workspace/project scope. Each edit must include oldText and newText. You can use this to apply and verify your code edits before building your final submit_result.',
      parameters: Type.Object({
        path: Type.String(),
        edits: Type.Array(
          Type.Object({
            oldText: Type.String(),
            newText: Type.String(),
            expectedOccurrences: Type.Optional(Type.Number()),
          }),
        ),
      }),
      execute: async (args) => {
        const sandbox = await getSandbox();
        const path = requireString(args.path, 'path');
        const edits = readPatchEdits(args.edits);
        const original = await sandbox.readFile(path);
        const { content, replacements } = applyExactTextEdits(original, edits);
        await sandbox.writeFile(path, content);
        emitToolProgress(options, {
          action: 'apply-patch',
          summary: `Applied ${replacements} replacement(s) to ${normalizeRepoRelativePath(sandbox.repoPath, path)}.`,
          evidence: [normalizeRepoRelativePath(sandbox.repoPath, path)],
        });
        return toToolJson({
          path: normalizeRepoRelativePath(sandbox.repoPath, path),
          status: 'patched',
          replacements,
        });
      },
    }),
    defineTool({
      name: 'coding_repo_apply_transaction',
      description:
        'Apply multiple UTF-8 file writes and exact-text patches atomically inside the selected coding-worker workspace/project scope. If any operation fails, every change made so far is rolled back and the result reports which operation failed and why.',
      parameters: Type.Object({
        id: Type.Optional(Type.String()),
        writes: Type.Optional(
          Type.Array(
            Type.Object({
              path: Type.String(),
              content: Type.String(),
            }),
          ),
        ),
        edits: Type.Optional(
          Type.Array(
            Type.Object({
              path: Type.String(),
              oldText: Type.String(),
              newText: Type.String(),
              expectedOccurrences: Type.Optional(Type.Number()),
            }),
          ),
        ),
      }),
      execute: async (args) => {
        const sandbox = await getSandbox();
        const writes = readTransactionWrites(args.writes);
        const edits = readTransactionEdits(args.edits);
        const id = readString(args.id) ?? `tx-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const transaction = createCodingEditTransaction(id, edits, writes);
        const result = await applyCodingEditTransaction(sandbox, transaction);

        const normalizedPaths = [
          ...writes.map((write) => normalizeRepoRelativePath(sandbox.repoPath, write.path)),
          ...edits.map((edit) => normalizeRepoRelativePath(sandbox.repoPath, edit.path)),
        ];
        emitToolProgress(options, {
          action: 'apply-transaction',
          summary:
            result.status === 'applied'
              ? `Applied transaction ${result.id} to ${normalizedPaths.length} file(s).`
              : `Transaction ${result.id} failed on ${result.failure?.path ?? 'unknown'}: ${result.failure?.reason ?? 'unknown'}`,
          evidence: normalizedPaths,
        });

        return toToolJson(result);
      },
    }),
    defineTool({
      name: 'coding_shell_run',
      description:
        'Run a command through the selected coding-worker workspace/project scope. Git/GitHub write commands are blocked and must use approval-gated paths.',
      parameters: Type.Object({
        command: Type.String(),
        cwd: Type.Optional(Type.String()),
        timeoutSeconds: Type.Optional(Type.Number()),
      }),
      execute: async (args) => {
        const command = requireString(args.command, 'command');
        const policy = evaluateCodingShellCommand(command);
        if (!policy.allowed) {
          return toToolJson({
            blocked: true,
            reason: policy.reason,
            approvalAction: policy.approvalAction,
          });
        }

        const sandbox = await getSandbox();
        const result = await sandbox.exec(command, {
          cwd: readString(args.cwd),
          timeoutSeconds: readPositiveInteger(args.timeoutSeconds) ?? 120,
        });
        emitToolProgress(options, {
          action: 'shell-run',
          summary: `Command exited with ${result.exitCode}: ${command}`,
          evidence: [command],
        });
        return toToolJson({
          command,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        });
      },
    }),
    defineTool({
      name: 'coding_project_create',
      description:
        'Create or resolve a project directory under the runtime workspace root. Projects are stored in projects/<slug>; repos are stored in repos/<slug>.',
      parameters: Type.Object({
        name: Type.Optional(Type.String()),
        slug: Type.Optional(Type.String()),
        directoryKind: Type.Optional(Type.String()),
        initializeReadme: Type.Optional(Type.Boolean()),
      }),
      execute: async (args) => {
        const sandbox = await getSandbox();
        const directoryKind = readProjectDirectoryKind(args.directoryKind);
        const slugSource = readString(args.slug) ?? requireString(args.name, 'name');
        const projectSlug = normalizeProjectSlug(slugSource);
        const projectRelativePath = createProjectRelativePath({
          directoryKind,
          projectSlug,
        });
        const target = resolveCodingWorkspaceTarget({
          workspaceRoot: sandbox.workspaceRoot,
          targetKind: directoryKind === 'repos' ? 'repo' : 'project',
          projectSlug,
          projectRelativePath,
        });

        await sandbox.mkdirWorkspace(target.projectRelativePath, { recursive: true });
        if (args.initializeReadme === true) {
          await sandbox.writeWorkspaceFile(
            `${target.projectRelativePath}/README.md`,
            `# ${projectSlug}\n`,
          );
        }

        emitToolProgress(options, {
          action: 'project-create',
          summary: `Resolved ${target.targetKind} at ${target.projectRelativePath}.`,
          evidence: [target.projectRelativePath],
        });

        return toToolJson({
          workspaceRoot: target.workspaceRoot,
          targetKind: target.targetKind,
          projectSlug,
          projectRelativePath: target.projectRelativePath,
          projectPath: target.scopePath,
          status: 'ready',
        });
      },
    }),
    defineTool({
      name: 'coding_progress_emit',
      description: 'Emit a sanitized public coding-worker progress event for orchestrator/user visibility.',
      parameters: Type.Object({
        type: Type.String(),
        summary: Type.String(),
        action: Type.Optional(Type.String()),
        nextAction: Type.Optional(Type.String()),
        evidence: Type.Optional(Type.Array(Type.String())),
      }),
      execute: async (args) => {
        if (!options.reporter || !options.taskId) {
          return toToolJson({
            available: false,
            summary: 'No coding progress reporter is attached to this worker run.',
          });
        }
        options.reporter.emit({
          type: readEventType(args.type),
          taskId: options.taskId,
          summary: requireString(args.summary, 'summary'),
          action: readString(args.action),
          nextAction: readString(args.nextAction),
          evidence: readStringArray(args.evidence),
        });
        return toToolJson({ status: 'emitted' });
      },
    }),
  ];
}

export interface ListRepoFilesOptions {
  root: string;
  maxFiles: number;
}

export async function listRepoFiles(
  sandbox: CodingSandboxRuntime,
  options: ListRepoFilesOptions,
): Promise<string[]> {
  const files: string[] = [];
  await collectFiles(sandbox, options.root, files, options.maxFiles);
  return files;
}

export interface SearchRepoOptions {
  query: string;
  root: string;
  maxResults: number;
}

export interface CodingRepoSearchResult {
  path: string;
  line: number;
  preview: string;
}

export async function searchRepo(
  sandbox: CodingSandboxRuntime,
  options: SearchRepoOptions,
): Promise<CodingRepoSearchResult[]> {
  const results: CodingRepoSearchResult[] = [];
  const files = await listRepoFiles(sandbox, {
    root: options.root,
    maxFiles: Math.max(options.maxResults * 20, options.maxResults),
  });

  for (const file of files) {
    if (results.length >= options.maxResults) {
      break;
    }

    let content = '';
    try {
      content = await sandbox.readFile(file);
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length && results.length < options.maxResults; index += 1) {
      if (lines[index].includes(options.query)) {
        results.push({
          path: file,
          line: index + 1,
          preview: lines[index].trim(),
        });
      }
    }
  }

  return results;
}

export interface CodingTextEdit {
  oldText: string;
  newText: string;
  expectedOccurrences?: number;
}

export function applyExactTextEdits(
  original: string,
  edits: CodingTextEdit[],
): { content: string; replacements: number } {
  let content = original;
  let replacements = 0;

  for (const edit of edits) {
    if (!edit.oldText) {
      throw new Error('Patch oldText must not be empty.');
    }

    const occurrences = countOccurrences(content, edit.oldText);
    if (occurrences === 0) {
      throw new Error('Patch oldText was not found.');
    }
    if (edit.expectedOccurrences !== undefined && occurrences !== edit.expectedOccurrences) {
      throw new Error(`Patch expected ${edit.expectedOccurrences} occurrence(s), found ${occurrences}.`);
    }

    content = content.split(edit.oldText).join(edit.newText);
    replacements += occurrences;
  }

  return { content, replacements };
}

/**
 * Result of one operation inside a `CodingEditTransaction`.
 */
export interface CodingEditOperationResult {
  path: string;
  operation: 'write' | 'patch';
  status: 'applied' | 'rolled_back' | 'failed';
  replacements?: number;
  reason?: string;
}

/**
 * Failure metadata for a `CodingEditTransaction`.
 */
export interface CodingEditTransactionFailure {
  path: string;
  operation: 'write' | 'patch';
  reason: string;
}

/**
 * Atomic multi-file edit transaction.
 *
 * All writes and exact-text patches are validated before any file is mutated.
 * On the first failure every change applied so far is rolled back and the
 * transaction reports which operation failed and why.
 */
export interface CodingEditTransaction {
  id: string;
  status: 'pending' | 'applied' | 'rolled_back' | 'failed';
  edits: CodingFileEdit[];
  writes: CodingFileWrite[];
  results: CodingEditOperationResult[];
  failure?: CodingEditTransactionFailure;
  createdAt: string;
  updatedAt: string;
}

class CodingEditTransactionError extends Error {
  constructor(
    readonly path: string,
    readonly operation: 'write' | 'patch',
    reason: string,
  ) {
    super(reason);
  }
}

/**
 * Build a pending edit transaction from file edits and writes.
 */
export function createCodingEditTransaction(
  id: string,
  edits: CodingFileEdit[],
  writes: CodingFileWrite[],
): CodingEditTransaction {
  const now = new Date().toISOString();
  return {
    id,
    status: 'pending',
    edits: edits.map((edit) => ({ ...edit })),
    writes: writes.map((write) => ({ ...write })),
    results: [],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Apply a `CodingEditTransaction` atomically inside the coding sandbox.
 *
 * Returns the transaction with status `applied` when every operation succeeds,
 * or status `failed` with `failure` and rolled-back `results` on the first
 * failure. Binary files and missing patch targets are rejected during pre-flight
 * validation before any file is written.
 */
export async function applyCodingEditTransaction(
  sandbox: CodingSandboxRuntime,
  transaction: CodingEditTransaction,
): Promise<CodingEditTransaction> {
  const tx = deepCloneTransaction(transaction);
  const now = new Date().toISOString();
  tx.updatedAt = now;

  if (tx.status !== 'pending') {
    return tx;
  }

  const snapshots = new Map<string, string | null>();
  const touchedPaths = new Set<string>();

  try {
    // Pre-flight validation: read originals and validate every edit.
    for (const write of tx.writes) {
      const normalizedPath = normalizeRepoRelativePath(sandbox.repoPath, write.path);
      if (touchedPaths.has(normalizedPath)) {
        throw new CodingEditTransactionError(write.path, 'write', `Duplicate write target: ${write.path}`);
      }
      touchedPaths.add(normalizedPath);

      const fileExists = await sandbox.exists(write.path);
      if (fileExists) {
        const original = await sandbox.readFile(write.path);
        if (isBinaryContent(original)) {
          throw new CodingEditTransactionError(write.path, 'write', 'Cannot overwrite binary file.');
        }
        snapshots.set(normalizedPath, original);
      } else {
        snapshots.set(normalizedPath, null);
      }
    }

    for (const edit of tx.edits) {
      const normalizedPath = normalizeRepoRelativePath(sandbox.repoPath, edit.path);
      if (touchedPaths.has(normalizedPath)) {
        throw new CodingEditTransactionError(edit.path, 'patch', `Path already targeted by a write: ${edit.path}`);
      }
      touchedPaths.add(normalizedPath);

      const fileExists = await sandbox.exists(edit.path);
      if (!fileExists) {
        throw new CodingEditTransactionError(edit.path, 'patch', 'File does not exist.');
      }

      const original = await sandbox.readFile(edit.path);
      if (isBinaryContent(original)) {
        throw new CodingEditTransactionError(edit.path, 'patch', 'Cannot patch binary file.');
      }

      validateExactTextEdit(edit, original);
      snapshots.set(normalizedPath, original);
    }

    // Apply writes first, then patches.
    for (const write of tx.writes) {
      try {
        await sandbox.writeFile(write.path, write.content);
        tx.results.push({
          path: write.path,
          operation: 'write',
          status: 'applied',
        });
      } catch (writeError) {
        throw new CodingEditTransactionError(
          write.path,
          'write',
          writeError instanceof Error ? writeError.message : String(writeError),
        );
      }
    }

    const editsByPath = groupEditsByPath(tx.edits);
    for (const [path, pathEdits] of editsByPath.entries()) {
      try {
        const normalizedPath = normalizeRepoRelativePath(sandbox.repoPath, path);
        const original = snapshots.get(normalizedPath) ?? '';
        const textEdits: CodingTextEdit[] = pathEdits.map((edit: CodingFileEdit) => ({
          oldText: edit.oldText,
          newText: edit.newText,
          expectedOccurrences: edit.expectedOccurrences,
        }));
        const { content, replacements } = applyExactTextEdits(original, textEdits);
        await sandbox.writeFile(path, content);
        tx.results.push({
          path,
          operation: 'patch',
          status: 'applied',
          replacements,
        });
      } catch (patchError) {
        if (patchError instanceof CodingEditTransactionError) {
          throw patchError;
        }
        throw new CodingEditTransactionError(
          path,
          'patch',
          patchError instanceof Error ? patchError.message : String(patchError),
        );
      }
    }

    tx.status = 'applied';
  } catch (error) {
    const failure: CodingEditTransactionFailure =
      error instanceof CodingEditTransactionError
        ? { path: error.path, operation: error.operation, reason: error.message }
        : {
            path: tx.results.at(-1)?.path ?? 'unknown',
            operation: tx.results.at(-1)?.operation ?? 'patch',
            reason: error instanceof Error ? error.message : String(error),
          };

    tx.failure = failure;
    tx.results = await rollbackCodingEditTransaction(sandbox, tx, snapshots);
    tx.status = 'failed';
  }

  tx.updatedAt = new Date().toISOString();
  return tx;
}

/**
 * Roll back operations from a failed transaction using captured snapshots.
 */
export async function rollbackCodingEditTransaction(
  sandbox: CodingSandboxRuntime,
  transaction: CodingEditTransaction,
  snapshots: Map<string, string | null>,
): Promise<CodingEditOperationResult[]> {
  const results = transaction.results.map((result) => ({ ...result }));

  for (const result of results) {
    if (result.status !== 'applied') {
      continue;
    }
    const normalizedPath = normalizeRepoRelativePath(sandbox.repoPath, result.path);
    const original = snapshots.get(normalizedPath);
    try {
      if (original === null) {
        // The file was created by this transaction; remove it to roll back.
        await sandbox.deleteFile(result.path);
      } else if (original !== undefined) {
        await sandbox.writeFile(result.path, original);
      } else {
        throw new Error('No snapshot available for rollback.');
      }
      result.status = 'rolled_back';
    } catch (rollbackError) {
      result.status = 'failed';
      result.reason = `Rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`;
    }
  }

  return results;
}

function deepCloneTransaction(transaction: CodingEditTransaction): CodingEditTransaction {
  if (typeof structuredClone === 'function') {
    return structuredClone(transaction);
  }
  return JSON.parse(JSON.stringify(transaction));
}

function isBinaryContent(content: string): boolean {
  return content.includes('\0');
}

function validateExactTextEdit(edit: CodingFileEdit, original: string): void {
  if (!edit.oldText) {
    throw new CodingEditTransactionError(edit.path, 'patch', 'Patch oldText must not be empty.');
  }
  const occurrences = countOccurrences(original, edit.oldText);
  if (occurrences === 0) {
    throw new CodingEditTransactionError(edit.path, 'patch', 'Patch oldText was not found.');
  }
  if (edit.expectedOccurrences !== undefined && occurrences !== edit.expectedOccurrences) {
    throw new CodingEditTransactionError(
      edit.path,
      'patch',
      `Patch expected ${edit.expectedOccurrences} occurrence(s), found ${occurrences}.`,
    );
  }
}

async function collectFiles(
  sandbox: CodingSandboxRuntime,
  path: string,
  files: string[],
  maxFiles: number,
): Promise<void> {
  if (files.length >= maxFiles) {
    return;
  }

  const stat = await sandbox.stat(path);
  const relativePath = normalizeRepoRelativePath(sandbox.repoPath, path);
  if (stat.isFile) {
    files.push(relativePath);
    return;
  }

  if (!stat.isDirectory) {
    return;
  }

  const names = await sandbox.readdir(path);
  for (const name of names.sort()) {
    if (files.length >= maxFiles) {
      return;
    }
    if (defaultIgnoredDirectories.has(name)) {
      continue;
    }
    await collectFiles(sandbox, join(path, name), files, maxFiles);
  }
}

function countOccurrences(content: string, search: string): number {
  return content.split(search).length - 1;
}

function groupEditsByPath(edits: CodingFileEdit[]): Map<string, CodingFileEdit[]> {
  const map = new Map<string, CodingFileEdit[]>();
  for (const edit of edits) {
    const list = map.get(edit.path) ?? [];
    list.push(edit);
    map.set(edit.path, list);
  }
  return map;
}

function emitToolProgress(
  options: CodingRepoToolsOptions,
  event: {
    action: string;
    summary: string;
    evidence?: string[];
  },
) {
  if (!options.reporter || !options.taskId) {
    return;
  }

  options.reporter.emit({
    type: 'coding.action.completed',
    taskId: options.taskId,
    action: event.action,
    summary: event.summary,
    evidence: event.evidence,
  });
}

function readPatchEdits(value: unknown): CodingTextEdit[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('At least one patch edit is required.');
  }

  return value.map((edit) => {
    if (!edit || typeof edit !== 'object') {
      throw new Error('Patch edit must be an object.');
    }
    const entry = edit as Record<string, unknown>;
    return {
      oldText: requireString(entry.oldText, 'oldText'),
      newText: requireString(entry.newText, 'newText'),
      expectedOccurrences: readPositiveInteger(entry.expectedOccurrences),
    };
  });
}

function readTransactionWrites(value: unknown): CodingFileWrite[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error('Transaction writes must be an array.');
  }

  return value.map((write) => {
    if (!write || typeof write !== 'object') {
      throw new Error('Transaction write must be an object.');
    }
    const entry = write as Record<string, unknown>;
    return {
      path: requireString(entry.path, 'path'),
      content: requireString(entry.content, 'content'),
    };
  });
}

function readTransactionEdits(value: unknown): CodingFileEdit[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error('Transaction edits must be an array.');
  }

  return value.map((edit) => {
    if (!edit || typeof edit !== 'object') {
      throw new Error('Transaction edit must be an object.');
    }
    const entry = edit as Record<string, unknown>;
    return {
      path: requireString(entry.path, 'path'),
      oldText: requireString(entry.oldText, 'oldText'),
      newText: requireString(entry.newText, 'newText'),
      expectedOccurrences: readPositiveInteger(entry.expectedOccurrences),
    };
  });
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((item): item is string => typeof item === 'string');
}

function readProjectDirectoryKind(value: unknown): CodingProjectDirectoryKind {
  if (value === undefined || value === null || value === '') {
    return 'projects';
  }
  if (value === 'projects' || value === 'repos') {
    return value;
  }
  throw new Error('directoryKind must be "projects" or "repos".');
}

function readPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  const integer = Math.floor(value);
  return integer > 0 ? integer : undefined;
}

function readEventType(value: unknown): CodingWorkerEventType {
  return typeof value === 'string' ? (value as CodingWorkerEventType) : 'coding.action.completed';
}

function toToolJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
