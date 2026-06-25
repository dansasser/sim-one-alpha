import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createLspTools } from '../engine/workers/coding-worker/tools/code-intelligence/lsp/lsp-tools.js';
import { createFlueLocalCodingSandbox } from '../engine/workers/coding-worker/tools/sandbox-runtime.js';
import { LspLanguageServerRegistry, type LanguageServerCommand } from '../engine/workers/coding-worker/tools/code-intelligence/lsp/lsp-server-registry.js';

const fixturesRoot = resolve(process.cwd(), 'src/tests/fixtures');

function assertCommandAvailable(command: LanguageServerCommand | undefined, name: string): asserts command is LanguageServerCommand {
  assert.ok(command, `expected ${name} language server to be available from bundled node_modules/.bin`);
}

function assertResolvedFromBundledBin(command: LanguageServerCommand, name: string): void {
  const hasNodeModulesBin = /node_modules[\\/]\.bin[\\/]/.test(command.command);
  const matchesName = command.command.endsWith(name) ||
                      command.command.endsWith(`${name}.cmd`) ||
                      command.command.endsWith(`${name}.exe`);

  assert.ok(
    hasNodeModulesBin || matchesName,
    `expected ${name} to be resolved from node_modules/.bin or PATH; got ${command.command}`,
  );
}

test('lsp_document_symbols with real typescript-language-server', async () => {
  const projectPath = join(fixturesRoot, 'repos/lsp-ts');
  const projectSlug = 'lsp-ts';
  const registry = new LspLanguageServerRegistry();
  const command = await registry.resolve('typescript');
  assertCommandAvailable(command, 'typescript-language-server');
  assertResolvedFromBundledBin(command, 'typescript-language-server');

  const workspaceRoot = fixturesRoot;
  const sandbox = await createFlueLocalCodingSandbox({
    workspaceRoot,
    targetKind: 'repo',
    repoPath: projectPath,
    projectSlug,
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

test('lsp_go_to_definition with real typescript-language-server', async () => {
  const projectPath = join(fixturesRoot, 'repos/lsp-ts');
  const projectSlug = 'lsp-ts';
  const registry = new LspLanguageServerRegistry();
  const command = await registry.resolve('typescript');
  assertCommandAvailable(command, 'typescript-language-server');

  const workspaceRoot = fixturesRoot;
  const sandbox = await createFlueLocalCodingSandbox({
    workspaceRoot,
    targetKind: 'repo',
    repoPath: projectPath,
    projectSlug,
  });

  const tools = createLspTools({
    workspaceRoot,
    sandbox,
    idleShutdownMs: 5_000,
  });

  const defTool = getTool(tools, 'lsp_go_to_definition');
  // Open calc.ts first so the server has it in the project graph, then look up
  // `add` at line 3 character 15 in main.ts. typescript-language-server resolves
  // it to the declaration in calc.ts.
  const docTool = getTool(tools, 'lsp_document_symbols');
  await docTool.execute({ path: 'src/calc.ts' });
  const raw = await defTool.execute({ path: 'src/main.ts', line: 3, character: 16 });
  const output = JSON.parse(raw) as {
    provider: string;
    lspAvailable: boolean;
    result: { definitions: Array<{ uri: string }> };
  };

  assert.equal(output.provider, 'lsp');
  assert.equal(output.lspAvailable, true);
  assert.ok(
    output.result.definitions.some((d) => d.uri.includes('calc.ts')),
    `expected at least one definition to point to calc.ts; got ${JSON.stringify(output.result.definitions)}`,
  );
});

test('lsp_document_symbols with real pyright-langserver', async () => {
  const projectPath = join(fixturesRoot, 'repos/lsp-py');
  const projectSlug = 'lsp-py';
  const registry = new LspLanguageServerRegistry();
  const command = await registry.resolve('python');
  assertCommandAvailable(command, 'pyright-langserver');
  assertResolvedFromBundledBin(command, 'pyright-langserver');

  const workspaceRoot = fixturesRoot;
  const sandbox = await createFlueLocalCodingSandbox({
    workspaceRoot,
    targetKind: 'repo',
    repoPath: projectPath,
    projectSlug,
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

test('lsp_hover with real pyright-langserver', async () => {
  const projectPath = join(fixturesRoot, 'repos/lsp-py');
  const projectSlug = 'lsp-py';
  const registry = new LspLanguageServerRegistry();
  const command = await registry.resolve('python');
  assertCommandAvailable(command, 'pyright-langserver');

  const workspaceRoot = fixturesRoot;
  const sandbox = await createFlueLocalCodingSandbox({
    workspaceRoot,
    targetKind: 'repo',
    repoPath: projectPath,
    projectSlug,
  });

  const tools = createLspTools({
    workspaceRoot,
    sandbox,
    idleShutdownMs: 5_000,
  });

  const hoverTool = getTool(tools, 'lsp_hover');
  // Position of `make_greeter` call in main.py on line 4 (0-indexed line 3)
  const raw = await hoverTool.execute({ path: 'main.py', line: 4, character: 15 });
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
