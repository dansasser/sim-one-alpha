import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  addToImportGraph,
  addToSymbolIndex,
  collapseExternalImports,
  createImportGraph,
  createSymbolIndex,
  findDeclarations,
  findDependencies,
  findDependents,
  findImportPath,
  findReferences,
  parseFile,
  parsePython,
  parseTypeScript,
} from '../workers/coding-worker/tools/code-intelligence/index.js';
import { createCodingCodeIntelligenceTools } from '../workers/coding-worker/tools/code-intelligence/index.js';
import { createFlueLocalCodingSandbox } from '../workers/coding-worker/tools/sandbox-runtime.js';

const tsSource = `
import { helper } from './helper.ts';
import * as fs from 'node:fs';
import defaultExport from './default-module';

export interface Config {
  value: number;
}

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

export const DEFAULT_CONFIG: Config = { value: 10 };

export { helper };
`;

const helperSource = `
export function helper(input: string): string {
  return input.toUpperCase();
}

export default helper;
`;

const pythonSource = `
import os
from typing import List

class Greeter:
    def __init__(self, name: str):
        self.name = name

    def greet(self) -> str:
        return f"Hello, {self.name}!"

def make_greeter(name: str) -> Greeter:
    return Greeter(name)
`;

const jsSource = `
import { add } from './math.js';

export function sum(a, b) {
  return add(a, b);
}

export class Adder {
  constructor(base) {
    this.base = base;
  }

  compute(x) {
    return this.base + x;
  }
}
`;

test('parseTypeScript extracts symbols, imports, and exports', () => {
  const result = parseTypeScript('src/calc.ts', tsSource);

  assert.equal(result.language, 'typescript');
  assert.equal(result.path, 'src/calc.ts');

  const names = result.symbols.map((s) => s.name);
  assert.ok(names.includes('Config'));
  assert.ok(names.includes('Calculator'));
  assert.ok(names.includes('add'));
  assert.ok(names.includes('createCalculator'));
  assert.ok(names.includes('DEFAULT_CONFIG'));
  assert.ok(names.includes('base'));

  const calculatorClass = result.symbols.find((s) => s.name === 'Calculator' && s.kind === 'class');
  assert.ok(calculatorClass);
  assert.equal(calculatorClass?.range.startLine > 0, true);

  const addMethod = result.symbols.find((s) => s.name === 'add' && s.kind === 'method');
  assert.ok(addMethod);
  assert.equal(addMethod?.container, 'Calculator');

  assert.equal(result.imports.length, 3);
  const namedImport = result.imports.find((i) => i.source === './helper.ts');
  assert.ok(namedImport);
  assert.equal(namedImport?.specifiers[0]?.name, 'helper');

  const namespaceImport = result.imports.find((i) => i.source === 'node:fs');
  assert.ok(namespaceImport);
  assert.equal(namespaceImport?.specifiers[0]?.isNamespace, true);

  const defaultImport = result.imports.find((i) => i.source === './default-module');
  assert.ok(defaultImport);
  assert.equal(defaultImport?.specifiers[0]?.isDefault, true);

  assert.ok(result.exports.some((e) => e.name === 'Config' && e.kind === 'named'));
  assert.ok(result.exports.some((e) => e.name === 'Calculator' && e.kind === 'named'));
  assert.ok(result.exports.some((e) => e.name === 'helper' && e.kind === 'named'));
});

test('parseFile dispatches to TypeScript parser', () => {
  const result = parseFile('src/calc.ts', tsSource);
  assert.equal(result.language, 'typescript');
  assert.ok(result.symbols.some((s) => s.name === 'Calculator' && s.kind === 'class'));
});

test('parseFile dispatches to JavaScript parser', () => {
  const result = parseFile('src/app.js', jsSource);
  assert.equal(result.language, 'javascript');
  assert.ok(result.symbols.some((s) => s.name === 'sum' && s.kind === 'function'));
  assert.ok(result.symbols.some((s) => s.name === 'Adder' && s.kind === 'class'));
  assert.ok(result.imports.some((i) => i.source === './math.js'));
});

test('parsePython extracts classes, methods, functions, and imports', () => {
  const result = parsePython('src/greeter.py', pythonSource);

  assert.equal(result.language, 'python');
  assert.ok(result.symbols.some((s) => s.name === 'Greeter' && s.kind === 'class'));

  const greetMethod = result.symbols.find((s) => s.name === 'greet');
  assert.ok(greetMethod);
  assert.equal(greetMethod?.kind, 'method');
  assert.equal(greetMethod?.container, 'Greeter');

  assert.ok(result.symbols.some((s) => s.name === 'make_greeter' && s.kind === 'function'));

  assert.ok(result.imports.some((i) => i.source === 'os' && i.specifiers[0]?.name === 'os'));
  assert.ok(result.imports.some((i) => i.source === 'typing' && i.specifiers[0]?.name === 'List'));
});

test('symbol index finds declarations and references', () => {
  const index = createSymbolIndex();
  const calcParsed = parseTypeScript('src/calc.ts', tsSource);
  addToSymbolIndex(index, calcParsed, tsSource);
  const helperParsed = parseTypeScript('src/helper.ts', helperSource);
  addToSymbolIndex(index, helperParsed, helperSource);

  const calcDeclarations = findDeclarations(index, 'Calculator');
  assert.equal(calcDeclarations.length, 1);
  assert.equal(calcDeclarations[0]?.path, 'src/calc.ts');
  assert.equal(calcDeclarations[0]?.kind, 'class');

  const helperDeclarations = findDeclarations(index, 'helper');
  assert.equal(helperDeclarations.length, 1);
  assert.equal(helperDeclarations[0]?.path, 'src/helper.ts');

  const calcRefs = findReferences(index, 'Calculator');
  assert.ok(calcRefs.length >= 1);
  assert.ok(calcRefs.some((ref) => ref.path === 'src/calc.ts'));
  assert.ok(!calcRefs.some((ref) => ref.kind === 'class' && ref.path === 'src/calc.ts'));
});

test('import graph tracks dependencies and dependents', () => {
  const graph = createImportGraph();
  const calcParsed = parseTypeScript('src/calc.ts', tsSource);
  addToImportGraph(graph, calcParsed);

  const deps = findDependencies(graph, 'src/calc.ts');
  assert.ok(deps.some((d) => d.includes('helper')));
  assert.ok(deps.some((d) => d.includes('default-module')));

  const dependents = findDependents(graph, 'src/helper.ts');
  assert.ok(dependents.includes('src/calc.ts'));
});

test('import graph finds path between files', () => {
  const graph = createImportGraph();
  const calcParsed = parseTypeScript('src/calc.ts', tsSource);
  const helperParsed = parseTypeScript('src/helper.ts', helperSource);
  addToImportGraph(graph, calcParsed);
  addToImportGraph(graph, helperParsed);

  const path = findImportPath(graph, 'src/calc.ts', 'src/helper.ts');
  assert.ok(path);
  assert.equal(path?.[0], 'src/calc.ts');
  assert.equal(path?.[path.length - 1], 'src/helper.ts');
});

test('import graph collapseExternalImports preserves internal nodes and edges', () => {
  const graph = createImportGraph();
  const calcParsed = parseTypeScript('src/calc.ts', tsSource);
  const helperParsed = parseTypeScript('src/helper.ts', helperSource);
  addToImportGraph(graph, calcParsed);
  addToImportGraph(graph, helperParsed);

  const collapsed = collapseExternalImports(graph);
  assert.ok(collapsed.nodes.has('src/calc.ts'));
  assert.ok(collapsed.nodes.has('src/helper.ts'));
  assert.ok(collapsed.nodes.has('src/default-module.ts'));
  assert.ok(!collapsed.nodes.has('node:fs'));

  const calcNode = collapsed.nodes.get('src/calc.ts')!;
  assert.ok(calcNode.outgoing.some((edge) => edge.target === 'src/helper.ts'));
  assert.ok(calcNode.outgoing.some((edge) => edge.target === 'src/default-module.ts'));
  assert.ok(!calcNode.outgoing.some((edge) => edge.target === 'node:fs'));

  const helperNode = collapsed.nodes.get('src/helper.ts')!;
  assert.ok(helperNode.incoming.some((edge) => edge.source === 'src/calc.ts'));
});

test('Flue code-intelligence tools parse a file through the sandbox', async () => {
  const workspaceRoot = createTempWorkspace();
  try {
    const projectPath = join(workspaceRoot, 'projects', 'test-app');
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(projectPath, 'calc.ts'), tsSource);

    const tools = createCodingCodeIntelligenceTools({
      workspaceRoot,
      targetKind: 'project',
      projectRelativePath: 'projects/test-app',
    });

    const parseTool = getTool(tools, 'coding_ast_parse_file');
    const output = JSON.parse(await parseTool.execute({ path: 'calc.ts' })) as {
      language: string;
      symbols: Array<{ name: string; kind: string }>;
      imports: Array<{ source: string }>;
    };

    assert.equal(output.language, 'typescript');
    assert.ok(output.symbols.some((s) => s.name === 'Calculator' && s.kind === 'class'));
    assert.ok(output.imports.some((i) => i.source === './helper.ts'));
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('Flue symbol navigation tool finds declarations and references', async () => {
  const workspaceRoot = createTempWorkspace();
  try {
    const projectPath = join(workspaceRoot, 'projects', 'test-app');
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(projectPath, 'calc.ts'), tsSource);
    writeFileSync(join(projectPath, 'helper.ts'), helperSource);

    const tools = createCodingCodeIntelligenceTools({
      workspaceRoot,
      targetKind: 'project',
      projectRelativePath: 'projects/test-app',
    });

    const navigateTool = getTool(tools, 'coding_symbol_navigate');
    const output = JSON.parse(await navigateTool.execute({ symbol: 'Calculator' })) as {
      symbol: string;
      declarations: Array<{ path: string; kind: string }>;
      references: Array<{ path: string }>;
      parsedFiles: string[];
    };

    assert.equal(output.symbol, 'Calculator');
    assert.equal(output.declarations.length, 1);
    assert.equal(output.declarations[0]?.path, 'calc.ts');
    assert.equal(output.declarations[0]?.kind, 'class');
    assert.ok(output.references.length >= 1);
    assert.ok(output.parsedFiles.includes('calc.ts'));
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('Flue import graph tool builds graph and focuses on a path', async () => {
  const workspaceRoot = createTempWorkspace();
  try {
    const projectPath = join(workspaceRoot, 'projects', 'test-app');
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(projectPath, 'calc.ts'), tsSource);
    writeFileSync(join(projectPath, 'helper.ts'), helperSource);

    const tools = createCodingCodeIntelligenceTools({
      workspaceRoot,
      targetKind: 'project',
      projectRelativePath: 'projects/test-app',
    });

    const graphTool = getTool(tools, 'coding_import_graph');
    const output = JSON.parse(await graphTool.execute({ path: 'calc.ts' })) as {
      nodes: Array<{ path: string; outgoing: Array<{ target: string }> }>;
      parsedFiles: string[];
      focusPath: string;
      dependencies: string[];
      dependents: string[];
    };

    assert.ok(output.nodes.length >= 2);
    assert.ok(output.parsedFiles.includes('calc.ts'));
    assert.ok(output.parsedFiles.includes('helper.ts'));
    assert.equal(output.focusPath, 'calc.ts');
    assert.ok(output.dependencies.some((d) => d.includes('helper')));
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('Flue find declarations tool returns only declarations', async () => {
  const workspaceRoot = createTempWorkspace();
  try {
    const projectPath = join(workspaceRoot, 'projects', 'test-app');
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(projectPath, 'calc.ts'), tsSource);

    const tools = createCodingCodeIntelligenceTools({
      workspaceRoot,
      targetKind: 'project',
      projectRelativePath: 'projects/test-app',
    });

    const findTool = getTool(tools, 'coding_find_symbol_declarations');
    const output = JSON.parse(await findTool.execute({ symbol: 'add' })) as {
      symbol: string;
      declarations: Array<{ path: string; kind: string }>;
      parsedFiles: string[];
    };

    assert.equal(output.symbol, 'add');
    assert.ok(output.declarations.length >= 1);
    assert.ok(output.declarations.some((d) => d.kind === 'method'));
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('Flue find references tool returns only references', async () => {
  const workspaceRoot = createTempWorkspace();
  try {
    const projectPath = join(workspaceRoot, 'projects', 'test-app');
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(projectPath, 'calc.ts'), tsSource);

    const tools = createCodingCodeIntelligenceTools({
      workspaceRoot,
      targetKind: 'project',
      projectRelativePath: 'projects/test-app',
    });

    const findTool = getTool(tools, 'coding_find_symbol_references');
    const output = JSON.parse(await findTool.execute({ symbol: 'Calculator' })) as {
      symbol: string;
      references: Array<{ path: string }>;
      parsedFiles: string[];
    };

    assert.equal(output.symbol, 'Calculator');
    assert.ok(output.references.length >= 1);
    assert.ok(output.references.every((r) => r.path === 'calc.ts'));
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

function createTempWorkspace() {
  return mkdtempSync(join(tmpdir(), 'code-intelligence-workspace-'));
}

function getTool(tools: import('@flue/runtime').ToolDefinition[], name: string) {
  const tool = tools.find((item) => item.name === name);
  assert.ok(tool, `expected tool ${name}`);
  return tool;
}
