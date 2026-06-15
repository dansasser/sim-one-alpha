import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createLspTools } from '../workers/coding-worker/tools/code-intelligence/lsp/lsp-tools.js';
import { createFlueLocalCodingSandbox } from '../workers/coding-worker/tools/sandbox-runtime.js';
import { LspLanguageServerRegistry } from '../workers/coding-worker/tools/code-intelligence/lsp/lsp-server-registry.js';

const fixturesRoot = resolve(import.meta.dirname ?? '.', 'fixtures');

function skipUnlessEnabled(t: TestContext) {
  if (process.env.GOROMBO_LSP_REAL_SERVER_TESTS !== '1') {
    t.skip('LSP integration tests disabled; set GOROMBO_LSP_REAL_SERVER_TESTS=1 to run.');
    return false;
  }
  return true;
}

test('lsp_document_symbols with real typescript-language-server', async (t) => {
  if (!skipUnlessEnabled(t)) return;

  const projectPath = join(fixturesRoot, 'lsp-ts');
  const registry = new LspLanguageServerRegistry();
  const command = await registry.resolve('typescript');
  if (!command) {
    t.skip('typescript-language-server not installed.');
    return;
  }

  const workspaceRoot = fixturesRoot;
  const sandbox = await createFlueLocalCodingSandbox({
    workspaceRoot,
    targetKind: 'repo',
    repoPath: projectPath,
  });

  const tools = createLspTools({
    workspaceRoot,
    sandbox,
    idleShutdownMs: 5_000,
  });

  const docSymbolsTool = getTool(tools, 'lsp_document_symbols');
  const raw = await docSymbolsTool.execute({ path: 'src/calc.ts' });
  const output = JSON.parse(raw) as {
    provider: string;
    lspAvailable: boolean;
    languageId: string;
    result: { symbols: Array<{ name: string; kind: number }> };
  };

  assert.equal(output.provider, 'lsp');
  assert.equal(output.lspAvailable, true);
  assert.equal(output.languageId, 'typescript');
  assert.ok(output.result.symbols.some((s) => s.name === 'Calculator' && s.kind === 5));
  assert.ok(output.result.symbols.some((s) => s.name === 'add' && s.kind === 12));
});

test('lsp_go_to_definition with real typescript-language-server', async (t) => {
  if (!skipUnlessEnabled(t)) return;

  const projectPath = join(fixturesRoot, 'lsp-ts');
  const registry = new LspLanguageServerRegistry();
  const command = await registry.resolve('typescript');
  if (!command) {
    t.skip('typescript-language-server not installed.');
    return;
  }

  const workspaceRoot = fixturesRoot;
  const sandbox = await createFlueLocalCodingSandbox({
    workspaceRoot,
    targetKind: 'repo',
    repoPath: projectPath,
  });

  const tools = createLspTools({
    workspaceRoot,
    sandbox,
    idleShutdownMs: 5_000,
  });

  const defTool = getTool(tools, 'lsp_go_to_definition');
  // Position of `calc.plus(5)` in main.ts — `plus` is at line 5, character ~24
  const raw = await defTool.execute({ path: 'src/main.ts', line: 4, character: 24 });
  const output = JSON.parse(raw) as {
    provider: string;
    lspAvailable: boolean;
    result: { definitions: Array<{ uri: string }> };
  };

  assert.equal(output.provider, 'lsp');
  assert.equal(output.lspAvailable, true);
  assert.ok(output.result.definitions.some((d) => d.uri.includes('calc.ts')));
});

test('lsp_document_symbols with real python-lsp-server', async (t) => {
  if (!skipUnlessEnabled(t)) return;

  const projectPath = join(fixturesRoot, 'lsp-py');
  const registry = new LspLanguageServerRegistry();
  const command = await registry.resolve('python');
  if (!command) {
    t.skip('python-lsp-server (pylsp) not installed.');
    return;
  }

  const workspaceRoot = fixturesRoot;
  const sandbox = await createFlueLocalCodingSandbox({
    workspaceRoot,
    targetKind: 'repo',
    repoPath: projectPath,
  });

  const tools = createLspTools({
    workspaceRoot,
    sandbox,
    idleShutdownMs: 5_000,
  });

  const docSymbolsTool = getTool(tools, 'lsp_document_symbols');
  const raw = await docSymbolsTool.execute({ path: 'greeter.py' });
  const output = JSON.parse(raw) as {
    provider: string;
    lspAvailable: boolean;
    languageId: string;
    result: { symbols: Array<{ name: string; kind: number }> };
  };

  assert.equal(output.provider, 'lsp');
  assert.equal(output.lspAvailable, true);
  assert.equal(output.languageId, 'python');
  assert.ok(output.result.symbols.some((s) => s.name === 'Greeter'));
  assert.ok(output.result.symbols.some((s) => s.name === 'greet'));
});

test('lsp_hover with real python-lsp-server', async (t) => {
  if (!skipUnlessEnabled(t)) return;

  const projectPath = join(fixturesRoot, 'lsp-py');
  const registry = new LspLanguageServerRegistry();
  const command = await registry.resolve('python');
  if (!command) {
    t.skip('python-lsp-server (pylsp) not installed.');
    return;
  }

  const workspaceRoot = fixturesRoot;
  const sandbox = await createFlueLocalCodingSandbox({
    workspaceRoot,
    targetKind: 'repo',
    repoPath: projectPath,
  });

  const tools = createLspTools({
    workspaceRoot,
    sandbox,
    idleShutdownMs: 5_000,
  });

  const hoverTool = getTool(tools, 'lsp_hover');
  // Position of `make_greeter` call in main.py
  const raw = await hoverTool.execute({ path: 'main.py', line: 5, character: 16 });
  const output = JSON.parse(raw) as {
    provider: string;
    lspAvailable: boolean;
    result: { hover: { contents: string } | null };
  };

  assert.equal(output.provider, 'lsp');
  assert.equal(output.lspAvailable, true);
  assert.ok(output.result.hover);
});

function getTool(tools: import('@flue/runtime').ToolDefinition[], name: string) {
  const tool = tools.find((item) => item.name === name);
  assert.ok(tool, `expected tool ${name}`);
  return tool;
}
