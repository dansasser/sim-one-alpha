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
import {
  createProjectRelativePath,
  normalizeProjectSlug,
  resolveCodingWorkspaceTarget,
  type CodingProjectDirectoryKind,
  type CodingWorkspaceTargetInput,
} from '../repo/workspace-target.js';
import type { CodingFileEdit } from '../../../schemas/coding-worker.js';

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
        'Apply exact text replacements to one UTF-8 file inside the selected coding-worker workspace/project scope. Each edit must include oldText and newText. Returns the applied CodingFileEdit objects so you can verify them before building your final submit_result.',
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
        const normalizedPath = normalizeRepoRelativePath(sandbox.repoPath, path);
        const original = await sandbox.readFile(path);
        const { content, replacements, appliedEdits } = applyExactTextEdits(original, edits);
        await sandbox.writeFile(path, content);
        emitToolProgress(options, {
          action: 'apply-patch',
          summary: `Applied ${replacements} replacement(s) to ${normalizedPath}.`,
          evidence: [normalizedPath],
        });
        const codingFileEdits: CodingFileEdit[] = appliedEdits.map((edit) => ({
          path: normalizedPath,
          oldText: edit.oldText,
          newText: edit.newText,
          expectedOccurrences: edit.expectedOccurrences,
        }));
        return toToolJson({
          path: normalizedPath,
          status: 'patched',
          replacements,
          edits: codingFileEdits,
        });
      },
    }),
    defineTool({
      name: 'coding_repo_apply_exact_edit',
      description:
        'Apply a single exact text replacement to one UTF-8 file inside the selected coding-worker workspace/project scope. Accepts one CodingFileEdit (path, oldText, newText, optional expectedOccurrences) and returns the applied edit object. Use this when you have one focused change to apply and verify.',
      parameters: Type.Object({
        path: Type.String(),
        oldText: Type.String(),
        newText: Type.String(),
        expectedOccurrences: Type.Optional(Type.Number()),
      }),
      execute: async (args) => {
        const sandbox = await getSandbox();
        const path = requireString(args.path, 'path');
        const normalizedPath = normalizeRepoRelativePath(sandbox.repoPath, path);
        const edit = readExactEdit(args);
        const original = await sandbox.readFile(path);
        const { content, replacements, appliedEdits } = applyExactTextEdits(original, [edit]);
        await sandbox.writeFile(path, content);
        emitToolProgress(options, {
          action: 'apply-exact-edit',
          summary: `Applied ${replacements} replacement(s) to ${normalizedPath}.`,
          evidence: [normalizedPath],
        });
        const appliedEdit: CodingFileEdit = {
          path: normalizedPath,
          oldText: edit.oldText,
          newText: edit.newText,
          expectedOccurrences: edit.expectedOccurrences,
        };
        return toToolJson({
          path: normalizedPath,
          status: 'patched',
          replacements,
          edit: appliedEdit,
        });
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

export interface CodingTextEditResult extends CodingTextEdit {
  replacements: number;
}

export function applyExactTextEdits(
  original: string,
  edits: CodingTextEdit[],
): { content: string; replacements: number; appliedEdits: CodingTextEditResult[] } {
  let content = original;
  let totalReplacements = 0;
  const appliedEdits: CodingTextEditResult[] = [];

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
    totalReplacements += occurrences;
    appliedEdits.push({
      oldText: edit.oldText,
      newText: edit.newText,
      expectedOccurrences: edit.expectedOccurrences,
      replacements: occurrences,
    });
  }

  return { content, replacements: totalReplacements, appliedEdits };
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

function readExactEdit(args: Record<string, unknown>): CodingTextEdit {
  return {
    oldText: requireString(args.oldText, 'oldText'),
    newText: requireString(args.newText, 'newText'),
    expectedOccurrences: readPositiveInteger(args.expectedOccurrences),
  };
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
