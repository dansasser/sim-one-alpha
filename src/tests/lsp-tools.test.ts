import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLspTools } from '../engine/workers/coding-worker/tools/code-intelligence/lsp/lsp-tools.js';
import { JsonRpcClient } from '../engine/workers/coding-worker/tools/code-intelligence/lsp/lsp-json-rpc.js';
import { createFlueLocalCodingSandbox } from '../engine/workers/coding-worker/tools/sandbox-runtime.js';
import type { CodingSandboxRuntime } from '../engine/workers/coding-worker/tools/sandbox-runtime.js';
import type { ChildProcess } from 'node:child_process';
import type { LspRequestContext } from '../engine/workers/coding-worker/tools/code-intelligence/lsp/lsp-client-manager.js';

const tsSource = `
import { helper } from './helper.ts';

export class Calculator {
  private base: number;

  constructor(base: number) {
    this.base = base;
  }

  public add(x: number): number {
    return this.base + x;
  }
}

export function createCalculator(base: number): Calculator {
  return new Calculator(base);
}
`;

const helperSource = `
export function helper(input: string): string {
  return input.toUpperCase();
}
`;

function createTempWorkspace() {
  return mkdtempSync(join(tmpdir(), 'lsp-tools-workspace-'));
}

function createMockClient(responses: Map<string, unknown>): JsonRpcClient {
  const stdin = { write: () => {} } as unknown as NodeJS.WritableStream;
  const stdout = {
    on: () => {},
    once: () => {},
    pipe: () => {},
    [Symbol.asyncIterator]: async function* () {},
  } as unknown as NodeJS.ReadableStream;
  const stderr = {
    on: () => {},
    once: () => {},
    pipe: () => {},
    [Symbol.asyncIterator]: async function* () {},
  } as unknown as NodeJS.ReadableStream;
  const proc = {
    stdin,
    stdout,
    stderr,
    killed: false,
    kill: () => {},
    on: () => {},
  } as unknown as ChildProcess;

  const client = new JsonRpcClient(proc);

  // Replace request with a mocked version that returns queued responses by method.
  client.request = async (method: string, _params: unknown) => {
    const response = responses.get(method);
    if (response === undefined) {
      throw new Error(`No mock response for ${method}`);
    }
    return response;
  };

  return client;
}

function createMockClientFactory(responses: Map<string, unknown>) {
  return (_context: LspRequestContext) => createMockClient(responses);
}

test('lsp_document_symbols returns normalized symbols when server is available', async () => {
  const workspaceRoot = createTempWorkspace();
  try {
    const projectPath = join(workspaceRoot, 'projects', 'test-app');
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(projectPath, 'calc.ts'), tsSource);
    const sandbox = await createFlueLocalCodingSandbox({
      workspaceRoot,
      targetKind: 'project',
      projectRelativePath: 'projects/test-app',
    });

    const responses = new Map<string, unknown>();
    responses.set('initialize', { capabilities: {} });
    responses.set('textDocument/documentSymbol', [
      {
        name: 'Calculator',
        kind: 5,
        range: { start: { line: 3, character: 0 }, end: { line: 12, character: 1 } },
        selectionRange: { start: { line: 3, character: 13 }, end: { line: 3, character: 23 } },
      },
      {
        name: 'add',
        kind: 6,
        range: { start: { line: 8, character: 2 }, end: { line: 10, character: 3 } },
        selectionRange: { start: { line: 8, character: 9 }, end: { line: 8, character: 12 } },
      },
    ]);

    const tools = createLspTools({
      workspaceRoot,
      sandbox,
      createJsonRpcClient: createMockClientFactory(responses),
    });

    const docSymbolsTool = getTool(tools, 'lsp_document_symbols');
    const raw = await docSymbolsTool.execute({ path: 'calc.ts' });
    const output = JSON.parse(raw) as {
      provider: string;
      lspAvailable: boolean;
      languageId: string;
      result: { symbols: Array<{ name: string; kind: number; range: unknown }> };
    };

    assert.equal(output.provider, 'lsp');
    assert.equal(output.lspAvailable, true);
    assert.equal(output.languageId, 'typescript');
    assert.equal(output.result.symbols.length, 2);
    assert.equal(output.result.symbols[0]?.name, 'Calculator');
    assert.equal(output.result.symbols[1]?.name, 'add');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('lsp_go_to_definition returns normalized locations', async () => {
  const workspaceRoot = createTempWorkspace();
  try {
    const projectPath = join(workspaceRoot, 'projects', 'test-app');
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(projectPath, 'calc.ts'), tsSource);
    writeFileSync(join(projectPath, 'helper.ts'), helperSource);

    const responses = new Map<string, unknown>();
    responses.set('initialize', { capabilities: {} });
    responses.set('textDocument/documentSymbol', [
      {
        name: 'add',
        kind: 6,
        range: { start: { line: 8, character: 2 }, end: { line: 10, character: 3 } },
        selectionRange: { start: { line: 8, character: 9 }, end: { line: 8, character: 12 } },
      },
    ]);
    responses.set('textDocument/definition', [
      {
        uri: `file://${projectPath}/helper.ts`,
        range: { start: { line: 0, character: 16 }, end: { line: 0, character: 22 } },
      },
    ]);

    const sandbox = await createFlueLocalCodingSandbox({
      workspaceRoot,
      targetKind: 'project',
      projectRelativePath: 'projects/test-app',
    });

    const tools = createLspTools({
      workspaceRoot,
      sandbox,
      createJsonRpcClient: createMockClientFactory(responses),
    });

    const defTool = getTool(tools, 'lsp_go_to_definition');
    const raw = await defTool.execute({ path: 'calc.ts', line: 8, character: 9 });
    const output = JSON.parse(raw) as {
      provider: string;
      lspAvailable: boolean;
      result: { definitions: Array<{ uri: string; range: { start: { line: number } } }> };
    };

    assert.equal(output.provider, 'lsp');
    assert.equal(output.lspAvailable, true);
    assert.equal(output.result.definitions.length, 1);
    assert.ok(output.result.definitions[0]?.uri.includes('helper.ts'));
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('lsp_find_references returns normalized references', async () => {
  const workspaceRoot = createTempWorkspace();
  try {
    const projectPath = join(workspaceRoot, 'projects', 'test-app');
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(projectPath, 'calc.ts'), tsSource);

    const responses = new Map<string, unknown>();
    responses.set('initialize', { capabilities: {} });
    responses.set('textDocument/documentSymbol', [
      {
        name: 'Calculator',
        kind: 5,
        range: { start: { line: 3, character: 0 }, end: { line: 12, character: 1 } },
        selectionRange: { start: { line: 3, character: 13 }, end: { line: 3, character: 23 } },
      },
    ]);
    responses.set('textDocument/references', [
      {
        uri: `file://${projectPath}/calc.ts`,
        range: { start: { line: 3, character: 13 }, end: { line: 3, character: 23 } },
      },
      {
        uri: `file://${projectPath}/calc.ts`,
        range: { start: { line: 14, character: 21 }, end: { line: 14, character: 31 } },
      },
    ]);

    const sandbox = await createFlueLocalCodingSandbox({
      workspaceRoot,
      targetKind: 'project',
      projectRelativePath: 'projects/test-app',
    });

    const tools = createLspTools({
      workspaceRoot,
      sandbox,
      createJsonRpcClient: createMockClientFactory(responses),
    });

    const refTool = getTool(tools, 'lsp_find_references');
    const raw = await refTool.execute({ path: 'calc.ts', line: 3, character: 13 });
    const output = JSON.parse(raw) as {
      provider: string;
      result: { references: Array<{ uri: string }> };
    };

    assert.equal(output.provider, 'lsp');
    assert.equal(output.result.references.length, 2);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('lsp_hover returns hover contents', async () => {
  const workspaceRoot = createTempWorkspace();
  try {
    const projectPath = join(workspaceRoot, 'projects', 'test-app');
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(projectPath, 'calc.ts'), tsSource);

    const responses = new Map<string, unknown>();
    responses.set('initialize', { capabilities: {} });
    responses.set('textDocument/hover', {
      contents: { language: 'typescript', value: '(method) Calculator.add(x: number): number' },
      range: { start: { line: 8, character: 9 }, end: { line: 8, character: 12 } },
    });

    const sandbox = await createFlueLocalCodingSandbox({
      workspaceRoot,
      targetKind: 'project',
      projectRelativePath: 'projects/test-app',
    });

    const tools = createLspTools({
      workspaceRoot,
      sandbox,
      createJsonRpcClient: createMockClientFactory(responses),
    });

    const hoverTool = getTool(tools, 'lsp_hover');
    const raw = await hoverTool.execute({ path: 'calc.ts', line: 8, character: 9 });
    const output = JSON.parse(raw) as {
      provider: string;
      result: { hover: { contents: { value: string } } };
    };

    assert.equal(output.provider, 'lsp');
    assert.ok(output.result.hover.contents.value.includes('add'));
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('lsp_prepare_rename returns range', async () => {
  const workspaceRoot = createTempWorkspace();
  try {
    const projectPath = join(workspaceRoot, 'projects', 'test-app');
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(projectPath, 'calc.ts'), tsSource);

    const responses = new Map<string, unknown>();
    responses.set('initialize', { capabilities: {} });
    responses.set('textDocument/prepareRename', {
      range: { start: { line: 8, character: 9 }, end: { line: 8, character: 12 } },
      placeholder: 'add',
    });

    const sandbox = await createFlueLocalCodingSandbox({
      workspaceRoot,
      targetKind: 'project',
      projectRelativePath: 'projects/test-app',
    });

    const tools = createLspTools({
      workspaceRoot,
      sandbox,
      createJsonRpcClient: createMockClientFactory(responses),
    });

    const renameTool = getTool(tools, 'lsp_prepare_rename');
    const raw = await renameTool.execute({ path: 'calc.ts', line: 8, character: 9 });
    const output = JSON.parse(raw) as {
      provider: string;
      result: { range: { start: { line: number } }; placeholder?: string };
    };

    assert.equal(output.provider, 'lsp');
    assert.equal(output.result.range.start.line, 8);
    assert.equal(output.result.placeholder, 'add');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('lsp_workspace_symbol searches workspace symbols', async () => {
  const workspaceRoot = createTempWorkspace();
  try {
    const projectPath = join(workspaceRoot, 'projects', 'test-app');
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(projectPath, 'package.json'), JSON.stringify({ name: 'test-app' }));
    writeFileSync(join(projectPath, 'calc.ts'), tsSource);

    const responses = new Map<string, unknown>();
    responses.set('initialize', { capabilities: {} });
    responses.set('workspace/symbol', {
      symbols: [
        {
          name: 'Calculator',
          kind: 5,
          location: {
            uri: `file://${projectPath}/calc.ts`,
            range: { start: { line: 3, character: 0 }, end: { line: 12, character: 1 } },
          },
          containerName: 'calc.ts',
        },
      ],
    });

    const tools = createLspTools({
      workspaceRoot,
      createJsonRpcClient: createMockClientFactory(responses),
    });

    const workspaceSymbolTool = getTool(tools, 'lsp_workspace_symbol');
    const raw = await workspaceSymbolTool.execute({ query: 'Calc' });
    const output = JSON.parse(raw) as {
      provider: string;
      result: { symbols: Array<{ name: string; containerName?: string }> };
    };

    assert.equal(output.provider, 'lsp');
    assert.equal(output.result.symbols.length, 1);
    assert.equal(output.result.symbols[0]?.name, 'Calculator');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('tool reports lsp unavailable for unsupported file extension', async () => {
  const workspaceRoot = createTempWorkspace();
  try {
    const projectPath = join(workspaceRoot, 'projects', 'test-app');
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(projectPath, 'README.md'), '# Hello');

    const tools = createLspTools({ workspaceRoot });

    const docSymbolsTool = getTool(tools, 'lsp_document_symbols');
    const raw = await docSymbolsTool.execute({ path: 'projects/test-app/README.md' });
    const output = JSON.parse(raw) as {
      provider: string;
      lspAvailable: boolean;
      languageId: string;
      fallbackReason?: string;
    };

    assert.equal(output.provider, 'none');
    assert.equal(output.lspAvailable, false);
    assert.equal(output.languageId, 'unknown');
    assert.ok(output.fallbackReason?.includes('Unsupported'));
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('wrapper tool returns empty when no symbol exists anywhere', async () => {
  // Fixture with NO mention of the symbol anywhere. typescript-language-
  // server finds zero hits, the wrapper's tryLspSymbolLookup returns null,
  // and the AST parser also finds zero hits.
  const workspaceRoot = createTempWorkspace();
  try {
    const projectPath = join(workspaceRoot, 'projects', 'test-app');
    mkdirSync(projectPath, { recursive: true });
    const onlySource = `export const greeting: string = 'hello';\n`;
    writeFileSync(join(projectPath, 'index.ts'), onlySource);

    const { createCodingCodeIntelligenceTools } = await import('../engine/workers/coding-worker/tools/code-intelligence/index.js');
    const tools = createCodingCodeIntelligenceTools({
      workspaceRoot,
      targetKind: 'project',
      projectRelativePath: 'projects/test-app',
    });

    const navigateTool = getTool(tools, 'coding_symbol_navigate');
    const raw = await navigateTool.execute({ symbol: 'NonexistentSymbol' });
    const output = JSON.parse(raw) as {
      symbol: string;
      provider: string;
      lspAvailable: boolean;
      declarations: Array<{ path: string; kind: string }>;
      references: Array<{ path: string }>;
    };

    assert.equal(output.symbol, 'NonexistentSymbol');
    // With the empty-LSP-result fallback fix, the wrapper reports the AST
    // path because the LSP returned zero hits.
    assert.equal(output.lspAvailable, false);
    assert.equal(output.provider, 'ast');
    assert.equal(output.declarations.length, 0);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

function getTool(tools: import('@flue/runtime').ToolDefinition[], name: string) {
  const tool = tools.find((item) => item.name === name);
  assert.ok(tool, `expected tool ${name}`);
  return tool;
}
