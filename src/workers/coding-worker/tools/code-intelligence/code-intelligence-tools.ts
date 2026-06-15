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
import { fileExtensionToLanguageId } from './lsp/lsp-server-registry.js';
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
import { createLspTools } from './lsp/lsp-tools.js';
import type { LspToolResult } from './lsp/lsp-types.js';

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

  const lspTools = createLspTools({
    workspaceRoot: options.workspaceRoot ?? process.cwd(),
    sandbox: options.sandbox,
    reporter: options.reporter,
    taskId: options.taskId,
    sessionId: options.sessionId,
  });

  return [
    defineTool({
      name: 'coding_ast_parse_file',
      description:
        'Parse a source file into an abstract syntax tree summary: symbols, imports, and exports. Supports TypeScript, JavaScript, and Python.',
      parameters: Type.Object({
        path: Type.String(),
      }),
      execute: async (args) => withToolProgress(options, 'ast-parse', async () => {
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
      }),
    }),
    defineTool({
      name: 'coding_symbol_navigate',
      description:
        'Find declarations and references for a symbol by name across the scoped source files. Prefers LSP where available, falls back to custom AST parsers. Supports TypeScript, JavaScript, and Python.',
      parameters: Type.Object({
        symbol: Type.String(),
        root: Type.Optional(Type.String()),
        maxFiles: Type.Optional(Type.Number()),
      }),
      execute: async (args) => withToolProgress(options, 'symbol-navigate', async () => {
        const sandbox = await getSandbox();
        const symbol = requireString(args.symbol, 'symbol');
        const root = readString(args.root) ?? '.';
        const maxFiles = readPositiveInteger(args.maxFiles) ?? 200;

        const lspResult = await tryLspSymbolLookup(
          sandbox,
          symbol,
          root,
          maxFiles,
          async () => createLspTools({
            workspaceRoot: options.workspaceRoot ?? process.cwd(),
            sandbox,
            reporter: options.reporter,
            taskId: options.taskId,
            sessionId: options.sessionId,
          }),
        );
        if (lspResult) {
          emitToolProgress(options, {
            action: 'symbol-navigate',
            summary: `LSP found ${lspResult.declarations.length} declaration(s) and ${lspResult.references.length} reference(s) for "${symbol}".`,
            evidence: lspResult.parsedFiles,
          });
          return toToolJson({
            symbol,
            provider: 'lsp',
            lspAvailable: true,
            declarations: lspResult.declarations,
            references: lspResult.references,
            parsedFiles: lspResult.parsedFiles,
          });
        }

        const { index, parsedFiles } = await buildIndexForScope(sandbox, root, maxFiles);
        const declarations = findDeclarations(index, symbol);
        const references = findReferences(index, symbol);
        emitToolProgress(options, {
          action: 'symbol-navigate',
          summary: `Found ${declarations.length} declaration(s) and ${references.length} reference(s) for "${symbol}" via AST fallback.`,
          evidence: parsedFiles,
        });
        return toToolJson({
          symbol,
          provider: 'ast',
          lspAvailable: false,
          declarations: declarations.map(stripCircular),
          references: references.map(stripCircular),
          parsedFiles,
        });
      }),
    }),
    defineTool({
      name: 'coding_find_symbol_declarations',
      description:
        'Find all declarations of a symbol by name across the scoped source files. Prefers LSP where available, falls back to custom AST parsers.',
      parameters: Type.Object({
        symbol: Type.String(),
        root: Type.Optional(Type.String()),
        maxFiles: Type.Optional(Type.Number()),
      }),
      execute: async (args) => withToolProgress(options, 'find-declarations', async () => {
        const sandbox = await getSandbox();
        const symbol = requireString(args.symbol, 'symbol');
        const root = readString(args.root) ?? '.';
        const maxFiles = readPositiveInteger(args.maxFiles) ?? 200;

        const lspResult = await tryLspSymbolLookup(
          sandbox,
          symbol,
          root,
          maxFiles,
          async () => createLspTools({
            workspaceRoot: options.workspaceRoot ?? process.cwd(),
            sandbox,
            reporter: options.reporter,
            taskId: options.taskId,
            sessionId: options.sessionId,
          }),
        );
        if (lspResult) {
          emitToolProgress(options, {
            action: 'find-declarations',
            summary: `LSP found ${lspResult.declarations.length} declaration(s) for "${symbol}".`,
            evidence: lspResult.parsedFiles,
          });
          return toToolJson({
            symbol,
            provider: 'lsp',
            lspAvailable: true,
            declarations: lspResult.declarations,
            parsedFiles: lspResult.parsedFiles,
          });
        }

        const { index, parsedFiles } = await buildIndexForScope(sandbox, root, maxFiles);
        const declarations = findDeclarations(index, symbol);
        emitToolProgress(options, {
          action: 'find-declarations',
          summary: `Found ${declarations.length} declaration(s) for "${symbol}" via AST fallback.`,
          evidence: parsedFiles,
        });
        return toToolJson({
          symbol,
          provider: 'ast',
          lspAvailable: false,
          declarations: declarations.map(stripCircular),
          parsedFiles,
        });
      }),
    }),
    defineTool({
      name: 'coding_find_symbol_references',
      description:
        'Find all references to a symbol by name across the scoped source files. Prefers LSP where available, falls back to custom AST parsers.',
      parameters: Type.Object({
        symbol: Type.String(),
        root: Type.Optional(Type.String()),
        maxFiles: Type.Optional(Type.Number()),
      }),
      execute: async (args) => withToolProgress(options, 'find-references', async () => {
        const sandbox = await getSandbox();
        const symbol = requireString(args.symbol, 'symbol');
        const root = readString(args.root) ?? '.';
        const maxFiles = readPositiveInteger(args.maxFiles) ?? 200;

        const lspResult = await tryLspSymbolLookup(
          sandbox,
          symbol,
          root,
          maxFiles,
          async () => createLspTools({
            workspaceRoot: options.workspaceRoot ?? process.cwd(),
            sandbox,
            reporter: options.reporter,
            taskId: options.taskId,
            sessionId: options.sessionId,
          }),
        );
        if (lspResult) {
          emitToolProgress(options, {
            action: 'find-references',
            summary: `LSP found ${lspResult.references.length} reference(s) for "${symbol}".`,
            evidence: lspResult.parsedFiles,
          });
          return toToolJson({
            symbol,
            provider: 'lsp',
            lspAvailable: true,
            references: lspResult.references,
            parsedFiles: lspResult.parsedFiles,
          });
        }

        const { index, parsedFiles } = await buildIndexForScope(sandbox, root, maxFiles);
        const references = findReferences(index, symbol);
        emitToolProgress(options, {
          action: 'find-references',
          summary: `Found ${references.length} reference(s) for "${symbol}" via AST fallback.`,
          evidence: parsedFiles,
        });
        return toToolJson({
          symbol,
          provider: 'ast',
          lspAvailable: false,
          references: references.map(stripCircular),
          parsedFiles,
        });
      }),
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
      execute: async (args) => withToolProgress(options, 'import-graph', async () => {
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
      }),
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

async function tryLspSymbolLookup(
  sandbox: CodingSandboxRuntime,
  symbolName: string,
  root: string,
  maxFiles: number,
  lspTools: ToolDefinition[] | (() => Promise<ToolDefinition[]>),
): Promise<{
  declarations: Record<string, unknown>[];
  references: Record<string, unknown>[];
  parsedFiles: string[];
} | null> {
  const files = await collectSourceFiles(sandbox, root, maxFiles);
  const candidates = files.filter((file) => {
    const lower = file.toLowerCase();
    const languageId = fileExtensionToLanguageId(lower.slice(lower.lastIndexOf('.')));
    return Boolean(languageId);
  });

  if (candidates.length === 0) {
    return null;
  }

  const tools = Array.isArray(lspTools) ? lspTools : await lspTools();
  const definitionTool = getTool(tools, 'lsp_go_to_definition');
  const referencesTool = getTool(tools, 'lsp_find_references');
  const documentSymbolsTool = getTool(tools, 'lsp_document_symbols');

  for (const file of candidates) {
    try {
      const symbolsRaw = await documentSymbolsTool.execute({ path: file });
      const symbolsResult = JSON.parse(symbolsRaw) as LspToolResult<{ symbols: Array<Record<string, unknown>> }>;
      if (!symbolsResult.lspAvailable) {
        continue;
      }

      const matchingSymbols = symbolsResult.result.symbols.filter((symbol) => symbol.name === symbolName);
      if (matchingSymbols.length === 0) {
        continue;
      }

      for (const matchingSymbol of matchingSymbols) {
        const range = matchingSymbol.range as {
          start: { line: number; character: number };
          end: { line: number; character: number };
        } | undefined;
        if (!range) {
          continue;
        }

        const [definitionsRaw, referencesRaw] = await Promise.all([
          definitionTool.execute({
            path: file,
            line: range.start.line,
            character: range.start.character,
          }),
          referencesTool.execute({
            path: file,
            line: range.start.line,
            character: range.start.character,
            includeDeclaration: false,
          }),
        ]);

      const definitionsResult = JSON.parse(definitionsRaw) as LspToolResult<{
        definitions: Array<Record<string, unknown>>;
      }>;
      const referencesResult = JSON.parse(referencesRaw) as LspToolResult<{
        references: Array<Record<string, unknown>>;
      }>;

      if (!definitionsResult.lspAvailable && !referencesResult.lspAvailable) {
        continue;
      }

      const parsedFiles = [
        ...new Set([
          file,
          ...definitionsResult.result.definitions.map((loc) => uriToRepoRelativePath(String(loc.uri ?? ''), sandbox.repoPath)),
          ...referencesResult.result.references.map((loc) => uriToRepoRelativePath(String(loc.uri ?? ''), sandbox.repoPath)),
        ]),
      ].filter(Boolean);

        return {
          declarations: definitionsResult.result.definitions.map((loc) => ({
            path: uriToRepoRelativePath(String(loc.uri ?? ''), sandbox.repoPath),
            name: symbolName,
            kind: loc.kind ? lspSymbolKindToString(Number(loc.kind)) : 'unknown',
            range: loc.range as Record<string, unknown>,
          })),
          references: referencesResult.result.references.map((loc) => ({
            path: uriToRepoRelativePath(String(loc.uri ?? ''), sandbox.repoPath),
            name: symbolName,
            kind: 'reference',
            range: loc.range as Record<string, unknown>,
          })),
          parsedFiles,
        };
      }
    } catch {
      continue;
    }
  }

  return null;
}

function uriToRepoRelativePath(uri: string, repoPath: string): string {
  if (!uri.startsWith('file://')) {
    return uri;
  }
  const absolute = uri.slice('file://'.length);
  const prefix = repoPath.endsWith('/') ? repoPath : `${repoPath}/`;
  if (absolute.startsWith(prefix)) {
    return absolute.slice(prefix.length);
  }
  return absolute;
}

function getTool(tools: ToolDefinition[], name: string) {
  const tool = tools.find((item) => item.name === name);
  if (!tool) {
    throw new Error(`expected tool ${name}`);
  }
  return tool;
}

function lspSymbolKindToString(kind: number): string {
  const kinds = [
    'file',
    'module',
    'namespace',
    'package',
    'class',
    'method',
    'property',
    'field',
    'constructor',
    'enum',
    'interface',
    'function',
    'variable',
    'constant',
    'string',
    'number',
    'boolean',
    'array',
    'object',
    'key',
    'null',
    'enumMember',
    'struct',
    'event',
    'operator',
    'typeParameter',
  ];
  return kinds[kind] ?? 'unknown';
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

function withToolProgress<T>(
  options: CodingCodeIntelligenceToolsOptions,
  action: string,
  operation: () => Promise<T>,
): Promise<T> {
  return operation().catch((error: unknown) => {
    emitToolProgress(options, {
      action: `${action}.failed`,
      summary: error instanceof Error ? error.message : String(error),
    });
    throw error;
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
