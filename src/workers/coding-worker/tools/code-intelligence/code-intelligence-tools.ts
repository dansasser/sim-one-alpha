import { defineTool, Type } from '@flue/runtime';
import { join } from 'node:path';
import type { ToolDefinition } from '@flue/runtime';
import {
  createFlueLocalCodingSandbox,
  normalizeRepoRelativePath,
  type CodingSandboxRuntime,
} from '../sandbox-runtime.js';
import type { CodingProgressReporter } from '../../events/progress-reporter.js';
import type { CodingWorkerEventType } from '../../events/coding-worker-events.js';
import {
  normalizeProjectSlug,
  resolveCodingWorkspaceTarget,
  type CodingWorkspaceTargetInput,
} from '../../repo/workspace-target.js';
import { parseFile, type ParseResult } from './ast-parser.js';
import {
  addToImportGraph,
  createImportGraph,
  findDependencies,
  findDependents,
  type ImportGraph,
} from './import-graph.js';
import {
  addToSymbolIndex,
  createSymbolIndex,
  findDeclarations,
  findReferences,
  type SymbolIndex,
  type SymbolLocation,
} from './symbol-index.js';

export interface CodingCodeIntelligenceToolsOptions extends CodingWorkspaceTargetInput {
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
  '__pycache__',
]);

const supportedSourceExtensions = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
]);

export function createCodingCodeIntelligenceTools(
  options: CodingCodeIntelligenceToolsOptions,
): ToolDefinition[] {
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
      name: 'coding_ast_parse_file',
      description:
        'Parse a source file into an abstract syntax tree summary: symbols, imports, and exports. Supports TypeScript, JavaScript, and Python.',
      parameters: Type.Object({
        path: Type.String(),
      }),
      execute: async (args) => {
        const sandbox = await getSandbox();
        const path = requireString(args.path, 'path');
        const content = await sandbox.readFile(path);
        const parsed = parseFile(path, content);
        emitToolProgress(options, {
          action: 'ast-parse',
          summary: `Parsed ${normalizeRepoRelativePath(sandbox.repoPath, path)} (${parsed.language}).`,
          evidence: [normalizeRepoRelativePath(sandbox.repoPath, path)],
        });
        return toToolJson(parsed);
      },
    }),
    defineTool({
      name: 'coding_symbol_navigate',
      description:
        'Find declarations and references for a symbol by name across the scoped source files. Supports TypeScript, JavaScript, and Python.',
      parameters: Type.Object({
        symbol: Type.String(),
        root: Type.Optional(Type.String()),
        maxFiles: Type.Optional(Type.Number()),
      }),
      execute: async (args) => {
        const sandbox = await getSandbox();
        const symbol = requireString(args.symbol, 'symbol');
        const root = readString(args.root) ?? '.';
        const maxFiles = readPositiveInteger(args.maxFiles) ?? 200;
        const { index, parsedFiles } = await buildIndexForScope(sandbox, root, maxFiles);
        const declarations = findDeclarations(index, symbol);
        const references = findReferences(index, symbol);
        emitToolProgress(options, {
          action: 'symbol-navigate',
          summary: `Found ${declarations.length} declaration(s) and ${references.length} reference(s) for "${symbol}".`,
          evidence: parsedFiles,
        });
        return toToolJson({
          symbol,
          declarations: declarations.map(stripCircular),
          references: references.map(stripCircular),
          parsedFiles,
        });
      },
    }),
    defineTool({
      name: 'coding_find_symbol_declarations',
      description:
        'Find all declarations of a symbol by name across the scoped source files.',
      parameters: Type.Object({
        symbol: Type.String(),
        root: Type.Optional(Type.String()),
        maxFiles: Type.Optional(Type.Number()),
      }),
      execute: async (args) => {
        const sandbox = await getSandbox();
        const symbol = requireString(args.symbol, 'symbol');
        const root = readString(args.root) ?? '.';
        const maxFiles = readPositiveInteger(args.maxFiles) ?? 200;
        const { index, parsedFiles } = await buildIndexForScope(sandbox, root, maxFiles);
        const declarations = findDeclarations(index, symbol);
        emitToolProgress(options, {
          action: 'find-declarations',
          summary: `Found ${declarations.length} declaration(s) for "${symbol}".`,
          evidence: parsedFiles,
        });
        return toToolJson({
          symbol,
          declarations: declarations.map(stripCircular),
          parsedFiles,
        });
      },
    }),
    defineTool({
      name: 'coding_find_symbol_references',
      description:
        'Find all references to a symbol by name across the scoped source files.',
      parameters: Type.Object({
        symbol: Type.String(),
        root: Type.Optional(Type.String()),
        maxFiles: Type.Optional(Type.Number()),
      }),
      execute: async (args) => {
        const sandbox = await getSandbox();
        const symbol = requireString(args.symbol, 'symbol');
        const root = readString(args.root) ?? '.';
        const maxFiles = readPositiveInteger(args.maxFiles) ?? 200;
        const { index, parsedFiles } = await buildIndexForScope(sandbox, root, maxFiles);
        const references = findReferences(index, symbol);
        emitToolProgress(options, {
          action: 'find-references',
          summary: `Found ${references.length} reference(s) for "${symbol}".`,
          evidence: parsedFiles,
        });
        return toToolJson({
          symbol,
          references: references.map(stripCircular),
          parsedFiles,
        });
      },
    }),
    defineTool({
      name: 'coding_import_graph',
      description:
        'Build an import graph for the scoped source files. Returns nodes, outgoing edges, incoming edges, dependencies, and dependents. Supports TypeScript, JavaScript, and Python.',
      parameters: Type.Object({
        root: Type.Optional(Type.String()),
        maxFiles: Type.Optional(Type.Number()),
        path: Type.Optional(Type.String()),
      }),
      execute: async (args) => {
        const sandbox = await getSandbox();
        const root = readString(args.root) ?? '.';
        const maxFiles = readPositiveInteger(args.maxFiles) ?? 200;
        const focusPath = readString(args.path);
        const { graph, parsedFiles } = await buildGraphForScope(sandbox, root, maxFiles);
        const nodeArray = [...graph.nodes.values()].map((node) => ({
          path: node.path,
          outgoing: node.outgoing,
          incoming: node.incoming,
        }));
        let dependencies: string[] | undefined;
        let dependents: string[] | undefined;
        if (focusPath) {
          dependencies = findDependencies(graph, focusPath);
          dependents = findDependents(graph, focusPath);
        }
        emitToolProgress(options, {
          action: 'import-graph',
          summary: `Built import graph across ${parsedFiles.length} file(s).`,
          evidence: parsedFiles,
        });
        return toToolJson({
          nodes: nodeArray,
          parsedFiles,
          ...(focusPath ? { focusPath, dependencies, dependents } : {}),
        });
      },
    }),
  ];
}

async function buildIndexForScope(
  sandbox: CodingSandboxRuntime,
  root: string,
  maxFiles: number,
): Promise<{ index: SymbolIndex; parsedFiles: string[] }> {
  const files = await collectSourceFiles(sandbox, root, maxFiles);
  const index = createSymbolIndex();
  const parsedFiles: string[] = [];
  for (const file of files) {
    try {
      const content = await sandbox.readFile(file);
      const parsed = parseFile(file, content);
      if (parsed.language === 'unknown') {
        continue;
      }
      addToSymbolIndex(index, parsed, content);
      parsedFiles.push(file);
    } catch {
      continue;
    }
  }
  return { index, parsedFiles };
}

async function buildGraphForScope(
  sandbox: CodingSandboxRuntime,
  root: string,
  maxFiles: number,
): Promise<{ graph: ImportGraph; parsedFiles: string[] }> {
  const files = await collectSourceFiles(sandbox, root, maxFiles);
  const graph = createImportGraph();
  const parsedFiles: string[] = [];
  for (const file of files) {
    try {
      const content = await sandbox.readFile(file);
      const parsed = parseFile(file, content);
      if (parsed.language === 'unknown') {
        continue;
      }
      addToImportGraph(graph, parsed);
      parsedFiles.push(file);
    } catch {
      continue;
    }
  }
  return { graph, parsedFiles };
}

async function collectSourceFiles(
  sandbox: CodingSandboxRuntime,
  root: string,
  maxFiles: number,
): Promise<string[]> {
  const files: string[] = [];
  await collectFiles(sandbox, root, files, maxFiles);
  return files.filter((file) => {
    const lower = file.toLowerCase();
    return [...supportedSourceExtensions].some((ext) => lower.endsWith(ext));
  });
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

function stripCircular(location: SymbolLocation): Record<string, unknown> {
  return {
    path: location.path,
    name: location.name,
    kind: location.kind,
    range: location.range,
    container: location.container,
    signature: location.signature,
  };
}

function emitToolProgress(
  options: CodingCodeIntelligenceToolsOptions,
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
    type: 'coding.action.completed' satisfies CodingWorkerEventType,
    taskId: options.taskId,
    action: event.action,
    summary: event.summary,
    evidence: event.evidence,
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

function readPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  const integer = Math.floor(value);
  return integer > 0 ? integer : undefined;
}

function toToolJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export { parseFile };
export type { ParseResult };
