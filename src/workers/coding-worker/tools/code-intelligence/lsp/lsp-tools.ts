import { defineTool, Type } from '@flue/runtime';
import type { ToolDefinition } from '@flue/runtime';
import { extname, resolve } from 'node:path';
import type { CodingSandboxRuntime } from '../../sandbox-runtime.js';
import type { CodingProgressReporter } from '../../../events/progress-reporter.js';
import type { CodingWorkerEventType } from '../../../events/coding-worker-events.js';
import { JsonRpcClient } from './lsp-json-rpc.js';
import { LspClientManager } from './lsp-client-manager.js';
import { fileExtensionToLanguageId as registryExtensionToLanguageId } from './lsp-server-registry.js';
import { detectProjectConfig } from './lsp-project-config.js';
import type {
  LspDefinitionResult,
  LspDocumentSymbol,
  LspDocumentSymbolsResult,
  LspHover,
  LspHoverResult,
  LspLocation,
  LspPosition,
  LspPrepareRenameResult,
  LspProvider,
  LspReferencesResult,
  LspSymbolInformation,
  LspToolResult,
  LspWorkspaceSymbolsResult,
} from './lsp-types.js';

export interface LspToolsOptions {
  workspaceRoot: string;
  /**
   * Optional sandbox. When omitted, file paths are resolved against the
   * current working directory and read directly from the file system.
   */
  sandbox?: CodingSandboxRuntime;
  reporter?: CodingProgressReporter;
  taskId?: string;
  sessionId?: string;
  idleShutdownMs?: number;
  /**
   * Test-only override. When provided, the manager uses this factory instead
   * of spawning real language servers.
   */
  createJsonRpcClient?: (context: {
    workspaceRoot: string;
    filePath: string;
    languageId: string;
    projectRoot: string;
  }) => JsonRpcClient;
}

export function createLspTools(options: LspToolsOptions): ToolDefinition[] {
  const manager = new LspClientManager({
    workspaceRoot: options.workspaceRoot,
    idleShutdownMs: options.idleShutdownMs,
    createJsonRpcClient: options.createJsonRpcClient
      ? (context) => options.createJsonRpcClient!(context)
      : undefined,
    onInitializing: (languageId) => {
      emitProgress(options, {
        action: 'coding.lsp.initializing',
        summary: `Starting ${languageId} language server.`,
        evidence: [languageId],
      });
    },
    onServerLog: (languageId, message) => {
      emitProgress(options, {
        action: 'coding.lsp.server-log',
        summary: `[${languageId}] ${message}`,
        evidence: [languageId],
      });
    },
  });

  const readFileForDidOpen = async (filePath: string): Promise<string> => {
    if (options.sandbox) {
      return options.sandbox.readFile(filePath);
    }
    const { readFile } = await import('node:fs/promises');
    return readFile(filePath, 'utf8');
  };

  const withDocument = async (filePath: string, languageIdHint?: string) => {
    const languageId = languageIdHint ?? extensionToLanguageId(filePath);
    if (!languageId) {
      return { ok: false, languageId: 'unknown', reason: `Unsupported file extension for ${filePath}.` } as const;
    }

    const absolutePath = options.sandbox
      ? options.sandbox.resolveScopePath(filePath)
      : resolve(filePath);
    const content = await readFileForDidOpen(absolutePath);
    const projectConfig = detectProjectConfig({
      workspaceRoot: options.workspaceRoot,
      filePath: absolutePath,
      languageId,
    });

    await manager.openDocument(absolutePath, languageId, content);

    return {
      ok: true as const,
      absolutePath,
      languageId,
      projectRoot: projectConfig.projectRoot,
    };
  };

  const runLspRequest = async <T>(
    input: { ok: true; absolutePath: string; languageId: string; projectRoot: string },
    method: string,
    params: unknown,
    emptyResult: T,
  ): Promise<LspToolResult<T>> => {
    const context = {
      workspaceRoot: options.workspaceRoot,
      filePath: input.absolutePath,
      languageId: input.languageId,
      projectRoot: input.projectRoot,
    };

    const raw = await manager.request(context, method, params);
    if (isLspUnavailable(raw)) {
      return {
        provider: 'none',
        lspAvailable: false,
        languageId: input.languageId,
        result: emptyResult,
        fallbackReason: String(raw.reason ?? 'Language server unavailable.'),
      };
    }

    return {
      provider: 'lsp',
      lspAvailable: true,
      languageId: input.languageId,
      result: raw as T,
    };
  };

  return [
    defineTool({
      name: 'lsp_go_to_definition',
      description:
        'Find the definition(s) of a symbol at a specific position in a source file using the language server.',
      parameters: Type.Object({
        path: Type.String(),
        line: Type.Number(),
        character: Type.Number(),
      }),
      execute: async (args) => withToolProgress(options, 'lsp-go-to-definition', async () => {
        const path = requireString(args.path, 'path');
        const line = requireNonNegativeInteger(args.line, 'line');
        const character = requireNonNegativeInteger(args.character, 'character');
        const document = await withDocument(path);
        if (!document.ok) {
          return toToolJson(unavailableResult<LspDefinitionResult>(document.languageId, document.reason, { definitions: [] }));
        }

        const result = await runLspRequest(
          document,
          'textDocument/definition',
          {
            textDocument: { uri: pathToUri(document.absolutePath) },
            position: { line, character },
          },
          { definitions: [] },
        );

        return toToolJson(normalizeResult(result, normalizeDefinitionResult));
      }),
    }),

    defineTool({
      name: 'lsp_find_references',
      description:
        'Find all references to a symbol at a specific position in a source file using the language server.',
      parameters: Type.Object({
        path: Type.String(),
        line: Type.Number(),
        character: Type.Number(),
        includeDeclaration: Type.Optional(Type.Boolean()),
      }),
      execute: async (args) => withToolProgress(options, 'lsp-find-references', async () => {
        const path = requireString(args.path, 'path');
        const line = requireNonNegativeInteger(args.line, 'line');
        const character = requireNonNegativeInteger(args.character, 'character');
        const includeDeclaration = readBoolean(args.includeDeclaration) ?? true;
        const document = await withDocument(path);
        if (!document.ok) {
          return toToolJson(unavailableResult<LspReferencesResult>(document.languageId, document.reason, { references: [] }));
        }

        const result = await runLspRequest(
          document,
          'textDocument/references',
          {
            textDocument: { uri: pathToUri(document.absolutePath) },
            position: { line, character },
            context: { includeDeclaration },
          },
          { references: [] },
        );

        return toToolJson(normalizeResult(result, normalizeReferencesResult));
      }),
    }),

    defineTool({
      name: 'lsp_document_symbols',
      description:
        'List all symbols defined in a source file using the language server.',
      parameters: Type.Object({
        path: Type.String(),
      }),
      execute: async (args) => withToolProgress(options, 'lsp-document-symbols', async () => {
        const path = requireString(args.path, 'path');
        const document = await withDocument(path);
        if (!document.ok) {
          return toToolJson(unavailableResult<LspDocumentSymbolsResult>(document.languageId, document.reason, { symbols: [] }));
        }

        const result = await runLspRequest(
          document,
          'textDocument/documentSymbol',
          {
            textDocument: { uri: pathToUri(document.absolutePath) },
          },
          { symbols: [] },
        );

        return toToolJson(normalizeResult(result, normalizeDocumentSymbolsResult));
      }),
    }),

    defineTool({
      name: 'lsp_workspace_symbol',
      description:
        'Search for symbols across the whole workspace using the language server.',
      parameters: Type.Object({
        query: Type.String(),
      }),
      execute: async (args) => withToolProgress(options, 'lsp-workspace-symbol', async () => {
        const query = requireString(args.query, 'query');
        // Use the workspace root as the project root; the registry will pick the
        // default language server for the first supported language it finds, or
        // TypeScript as a sensible default in Flue/Astro codebases.
        const languageId = guessPrimaryLanguageId(options.workspaceRoot) ?? 'typescript';
        const projectConfig = detectProjectConfig({
          workspaceRoot: options.workspaceRoot,
          filePath: options.workspaceRoot,
          languageId,
        });

        const context = {
          workspaceRoot: options.workspaceRoot,
          filePath: options.workspaceRoot,
          languageId,
          projectRoot: projectConfig.projectRoot,
        };

        const raw = await manager.request(context, 'workspace/symbol', { query });
        if (isLspUnavailable(raw)) {
          return toToolJson(
            unavailableResult<LspWorkspaceSymbolsResult>(languageId, String(raw.reason ?? 'Language server unavailable.'), {
              symbols: [],
            }),
          );
        }

        const result: LspToolResult<LspWorkspaceSymbolsResult> = {
          provider: 'lsp',
          lspAvailable: true,
          languageId,
          result: raw as LspWorkspaceSymbolsResult,
        };

        return toToolJson(normalizeResult(result, normalizeWorkspaceSymbolsResult));
      }),
    }),

    defineTool({
      name: 'lsp_hover',
      description:
        'Get hover/type information for a symbol at a specific position in a source file using the language server.',
      parameters: Type.Object({
        path: Type.String(),
        line: Type.Number(),
        character: Type.Number(),
      }),
      execute: async (args) => withToolProgress(options, 'lsp-hover', async () => {
        const path = requireString(args.path, 'path');
        const line = requireNonNegativeInteger(args.line, 'line');
        const character = requireNonNegativeInteger(args.character, 'character');
        const document = await withDocument(path);
        if (!document.ok) {
          return toToolJson(unavailableResult<LspHoverResult>(document.languageId, document.reason, { hover: null }));
        }

        const result = await runLspRequest(
          document,
          'textDocument/hover',
          {
            textDocument: { uri: pathToUri(document.absolutePath) },
            position: { line, character },
          },
          { hover: null },
        );

        return toToolJson(normalizeResult(result, normalizeHoverResult));
      }),
    }),

    defineTool({
      name: 'lsp_prepare_rename',
      description:
        'Ask the language server for the range that would be renamed at a specific position.',
      parameters: Type.Object({
        path: Type.String(),
        line: Type.Number(),
        character: Type.Number(),
      }),
      execute: async (args) => withToolProgress(options, 'lsp-prepare-rename', async () => {
        const path = requireString(args.path, 'path');
        const line = requireNonNegativeInteger(args.line, 'line');
        const character = requireNonNegativeInteger(args.character, 'character');
        const document = await withDocument(path);
        if (!document.ok) {
          return toToolJson(unavailableResult<LspPrepareRenameResult>(document.languageId, document.reason, { range: null }));
        }

        const result = await runLspRequest(
          document,
          'textDocument/prepareRename',
          {
            textDocument: { uri: pathToUri(document.absolutePath) },
            position: { line, character },
          },
          { range: null },
        );

        return toToolJson(normalizeResult(result, normalizePrepareRenameResult));
      }),
    }),
  ];
}

function isLspUnavailable(value: unknown): value is { lspAvailable: false; reason?: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'lspAvailable' in value &&
    (value as { lspAvailable: unknown }).lspAvailable === false
  );
}

function unavailableResult<T>(languageId: string, reason: string, empty: T): LspToolResult<T> {
  return {
    provider: 'none',
    lspAvailable: false,
    languageId,
    result: empty,
    fallbackReason: reason,
  };
}

function normalizeResult<T, U>(
  result: LspToolResult<T>,
  normalizer: (value: T) => U,
): LspToolResult<U> {
  return {
    provider: result.provider,
    lspAvailable: result.lspAvailable,
    languageId: result.languageId,
    result: normalizer(result.result),
    fallbackReason: result.fallbackReason,
  };
}

function normalizeDefinitionResult(value: LspDefinitionResult | unknown[]): LspDefinitionResult {
  // LSP textDocument/definition returns either a single Location, an array of
  // Locations, or a LinkLocation array. We normalize to our result shape.
  const definitions = Array.isArray(value)
    ? value
    : (value as LspDefinitionResult).definitions;
  return {
    definitions: normalizeLocationArray(definitions) as LspLocation[],
  };
}

function normalizeReferencesResult(value: LspReferencesResult | unknown[]): LspReferencesResult {
  const references = Array.isArray(value)
    ? value
    : (value as LspReferencesResult).references;
  return {
    references: normalizeLocationArray(references) as LspLocation[],
  };
}

function normalizeDocumentSymbolsResult(
  value: LspDocumentSymbolsResult | unknown[],
): LspDocumentSymbolsResult {
  const symbols = Array.isArray(value) ? value : (value as LspDocumentSymbolsResult).symbols;
  return {
    symbols: normalizeDocumentSymbolArray(symbols) as LspDocumentSymbol[],
  };
}

function normalizeWorkspaceSymbolsResult(
  value: LspWorkspaceSymbolsResult | LspSymbolInformation[],
): LspWorkspaceSymbolsResult {
  // Real LSP servers return either an array of SymbolInformation directly or an
  // object with a `symbols` property. Accept both shapes.
  const symbols = Array.isArray(value) ? value : value.symbols;
  return {
    symbols: normalizeSymbolInformationArray(symbols) as LspSymbolInformation[],
  };
}

function normalizeHoverResult(value: LspHoverResult | { contents: unknown; range?: unknown }): LspHoverResult {
  // LSP textDocument/hover returns either null or a Hover object directly. We
  // also accept our own wrapped shape for consistency.
  if (value === null || value === undefined) {
    return { hover: null };
  }
  if ('hover' in value) {
    const hover = (value as LspHoverResult).hover;
    if (!hover) {
      return { hover: null };
    }
    return {
      hover: {
        contents: hover.contents,
        range: hover.range ? normalizeRange(hover.range) : undefined,
      },
    };
  }
  const direct = value as { contents: unknown; range?: unknown };
  return {
    hover: {
      contents: direct.contents as LspHover['contents'],
      range: direct.range ? normalizeRange(direct.range as { start: LspPosition; end: LspPosition }) : undefined,
    },
  };
}

function normalizePrepareRenameResult(value: LspPrepareRenameResult): LspPrepareRenameResult {
  if (!value.range) {
    return { range: null };
  }

  // LSP prepareRename can return either a Range or { range, placeholder }.
  if ('start' in value.range && 'end' in value.range) {
    return {
      range: normalizeRange(value.range),
      placeholder: value.placeholder,
    };
  }

  const placeholder = (value as { placeholder?: string }).placeholder;
  const range = (value as { range?: unknown }).range;
  if (range && typeof range === 'object' && 'start' in range && 'end' in range) {
    return {
      range: normalizeRange(range as { start: LspPosition; end: LspPosition }),
      placeholder,
    };
  }

  return { range: null };
}

function normalizeLocationArray(locations: unknown[]): unknown[] {
  if (!Array.isArray(locations)) {
    return [];
  }
  return locations.map((loc) => normalizeLocation(loc as Record<string, unknown>));
}

function normalizeLocation(location: Record<string, unknown>): Record<string, unknown> {
  const uri = typeof location.uri === 'string' ? location.uri : '';
  const range = normalizeRange(
    (location.range as { start: LspPosition; end: LspPosition }) ?? {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
    },
  );
  return { uri, range };
}

function normalizeDocumentSymbolArray(symbols: unknown[]): unknown[] {
  if (!Array.isArray(symbols)) {
    return [];
  }
  return symbols.map((symbol) => normalizeDocumentSymbol(symbol as Record<string, unknown>));
}

function normalizeDocumentSymbol(symbol: Record<string, unknown>): Record<string, unknown> {
  const children = symbol.children ? normalizeDocumentSymbolArray(symbol.children as unknown[]) : undefined;
  return {
    name: String(symbol.name ?? ''),
    detail: typeof symbol.detail === 'string' ? symbol.detail : undefined,
    kind: Number(symbol.kind ?? 0),
    range: normalizeRange(
      (symbol.range as { start: LspPosition; end: LspPosition }) ?? {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      },
    ),
    selectionRange: normalizeRange(
      (symbol.selectionRange as { start: LspPosition; end: LspPosition }) ?? {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      },
    ),
    ...(children ? { children } : {}),
  };
}

function normalizeSymbolInformationArray(symbols: unknown[]): unknown[] {
  if (!Array.isArray(symbols)) {
    return [];
  }
  return symbols.map((symbol) => {
    const record = symbol as Record<string, unknown>;
    return {
      name: String(record.name ?? ''),
      kind: Number(record.kind ?? 0),
      containerName: typeof record.containerName === 'string' ? record.containerName : undefined,
      location: normalizeLocation((record.location as Record<string, unknown>) ?? { uri: '', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }),
    };
  });
}

function normalizeRange(range: { start: LspPosition; end: LspPosition }): {
  start: LspPosition;
  end: LspPosition;
} {
  return {
    start: normalizePosition(range.start),
    end: normalizePosition(range.end),
  };
}

function normalizePosition(position: LspPosition): LspPosition {
  return {
    line: Number(position?.line ?? 0),
    character: Number(position?.character ?? 0),
  };
}

function extensionToLanguageId(filePath: string): string | undefined {
  return registryExtensionToLanguageId(extname(filePath));
}

function localFileExtensionToLanguageId(extension: string): string | undefined {
  const map: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.astro': 'astro',
    '.py': 'python',
  };
  return map[extension.toLowerCase()];
}

import { existsSync } from 'node:fs';

function guessPrimaryLanguageId(workspaceRoot: string): string | undefined {
  // Workspace-level symbol search is inherently language-specific. Prefer TS/JS
  // because Flue/Astro codebases are TypeScript-first; Python workspaces can
  // override by using the explicit lsp_* tools with a file path.
  if (
    existsSync(resolve(workspaceRoot, 'tsconfig.json')) ||
    existsSync(resolve(workspaceRoot, 'package.json'))
  ) {
    return 'typescript';
  }
  if (
    existsSync(resolve(workspaceRoot, 'pyproject.toml')) ||
    existsSync(resolve(workspaceRoot, 'requirements.txt'))
  ) {
    return 'python';
  }
  return 'typescript';
}

import { pathToFileURL } from 'node:url';

function pathToUri(filePath: string): string {
  return pathToFileURL(filePath).href;
}

function emitProgress(
  options: LspToolsOptions,
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
  options: LspToolsOptions,
  action: string,
  operation: () => Promise<T>,
): Promise<T> {
  return operation().catch((error: unknown) => {
    emitProgress(options, {
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

function requireNonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} must be a number.`);
  }
  const integer = Math.floor(value);
  if (integer < 0) {
    throw new Error(`${name} must be non-negative.`);
  }
  return integer;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function toToolJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
