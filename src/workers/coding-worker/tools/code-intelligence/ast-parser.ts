import * as ts from 'typescript';

export type CodeSymbolKind =
  | 'function'
  | 'class'
  | 'method'
  | 'variable'
  | 'interface'
  | 'type'
  | 'enum'
  | 'module'
  | 'import'
  | 'export'
  | 'parameter'
  | 'property'
  | 'unknown';

export interface CodeSymbolRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface CodeSymbol {
  name: string;
  kind: CodeSymbolKind;
  path: string;
  range: CodeSymbolRange;
  container?: string;
  signature?: string;
}

export interface ImportSpecifierInfo {
  name: string;
  alias?: string;
  isDefault?: boolean;
  isNamespace?: boolean;
}

export interface ImportInfo {
  source: string;
  specifiers: ImportSpecifierInfo[];
  range: CodeSymbolRange;
}

export interface ExportInfo {
  name: string;
  kind: 'named' | 'default' | 'namespace' | 're-export';
  range: CodeSymbolRange;
  source?: string;
}

export interface ParseResult {
  path: string;
  language: 'typescript' | 'javascript' | 'python' | 'unknown';
  symbols: CodeSymbol[];
  imports: ImportInfo[];
  exports: ExportInfo[];
}

export interface ParseFileOptions {
  tsConfigPath?: string;
}

export function parseFile(path: string, content: string, options?: ParseFileOptions): ParseResult {
  if (path.endsWith('.ts') || path.endsWith('.tsx') || path.endsWith('.mts') || path.endsWith('.cts')) {
    return parseTypeScript(path, content, options);
  }
  if (path.endsWith('.js') || path.endsWith('.jsx') || path.endsWith('.mjs') || path.endsWith('.cjs')) {
    return parseJavaScript(path, content, options);
  }
  if (path.endsWith('.py')) {
    return parsePython(path, content);
  }
  return {
    path,
    language: 'unknown',
    symbols: [],
    imports: [],
    exports: [],
  };
}

export function parseTypeScript(path: string, content: string, options?: ParseFileOptions): ParseResult {
  const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, kind);
  return parseSourceFile(path, sourceFile, content, 'typescript');
}

export function parseJavaScript(path: string, content: string, _options?: ParseFileOptions): ParseResult {
  const kind = path.endsWith('.jsx') ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, kind);
  return parseSourceFile(path, sourceFile, content, 'javascript');
}

function parseSourceFile(
  path: string,
  sourceFile: ts.SourceFile,
  content: string,
  language: 'typescript' | 'javascript',
): ParseResult {
  const symbols: CodeSymbol[] = [];
  const imports: ImportInfo[] = [];
  const exports: ExportInfo[] = [];
  const addSymbol = (name: string, kind: CodeSymbolKind, node: ts.Node, container?: string) => {
    symbols.push({
      name,
      kind,
      path,
      range: nodeRange(sourceFile, node),
      container,
      signature: extractSignature(content, node),
    });
  };

  function visit(node: ts.Node, container?: string) {
    if (ts.isImportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier;
      if (ts.isStringLiteral(moduleSpecifier)) {
        const specifiers: ImportSpecifierInfo[] = [];
        if (node.importClause) {
          if (node.importClause.name) {
            specifiers.push({
              name: node.importClause.name.text,
              isDefault: true,
            });
          }
          if (node.importClause.namedBindings) {
            if (ts.isNamedImports(node.importClause.namedBindings)) {
              for (const element of node.importClause.namedBindings.elements) {
                specifiers.push({
                  name: element.name.text,
                  alias: element.propertyName?.text,
                  isDefault: element.name.text === 'default',
                });
              }
            } else if (ts.isNamespaceImport(node.importClause.namedBindings)) {
              specifiers.push({
                name: node.importClause.namedBindings.name.text,
                isNamespace: true,
              });
            }
          }
        }
        imports.push({
          source: moduleSpecifier.text,
          specifiers,
          range: nodeRange(sourceFile, node),
        });
      }
    }

    if (ts.isExportDeclaration(node)) {
      const source = node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : undefined;
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          exports.push({
            name: element.name.text,
            kind: source ? 're-export' : 'named',
            range: nodeRange(sourceFile, element),
            source,
          });
        }
      } else if (!node.exportClause) {
        exports.push({
          name: '*',
          kind: 'namespace',
          range: nodeRange(sourceFile, node),
          source,
        });
      }
    }

    if (ts.isExportAssignment(node)) {
      const name = ts.isIdentifier(node.expression) ? node.expression.text : 'default';
      exports.push({
        name,
        kind: 'default',
        range: nodeRange(sourceFile, node),
      });
    }

    if (ts.isFunctionDeclaration(node) && node.name) {
      const kind: CodeSymbolKind = 'function';
      addSymbol(node.name.text, kind, node, container);
      if (hasExportModifier(node)) {
        exports.push({ name: node.name.text, kind: 'named', range: nodeRange(sourceFile, node) });
      }
      ts.forEachChild(node, (child) => visit(child, node.name!.text));
      return;
    }

    if (ts.isClassDeclaration(node) && node.name) {
      addSymbol(node.name.text, 'class', node, container);
      if (hasExportModifier(node)) {
        exports.push({ name: node.name.text, kind: 'named', range: nodeRange(sourceFile, node) });
      }
      for (const member of node.members) {
        visit(member, node.name.text);
      }
      return;
    }

    if (ts.isInterfaceDeclaration(node) && node.name) {
      addSymbol(node.name.text, 'interface', node, container);
      if (hasExportModifier(node)) {
        exports.push({ name: node.name.text, kind: 'named', range: nodeRange(sourceFile, node) });
      }
      ts.forEachChild(node, (child) => visit(child, node.name!.text));
      return;
    }

    if (ts.isEnumDeclaration(node) && node.name) {
      addSymbol(node.name.text, 'enum', node, container);
      if (hasExportModifier(node)) {
        exports.push({ name: node.name.text, kind: 'named', range: nodeRange(sourceFile, node) });
      }
      ts.forEachChild(node, (child) => visit(child, node.name!.text));
      return;
    }

    if (ts.isTypeAliasDeclaration(node) && node.name) {
      addSymbol(node.name.text, 'type', node, container);
      if (hasExportModifier(node)) {
        exports.push({ name: node.name.text, kind: 'named', range: nodeRange(sourceFile, node) });
      }
      return;
    }

    if (ts.isVariableStatement(node) && hasExportModifier(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          exports.push({
            name: declaration.name.text,
            kind: 'named',
            range: nodeRange(sourceFile, declaration),
          });
        }
      }
    }

    if (ts.isVariableDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
      addSymbol(node.name.text, 'variable', node, container);
    }

    if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
      const methodName = node.name.text;
      addSymbol(methodName, 'method', node, container);
      ts.forEachChild(node, (child) => visit(child, `${container}.${methodName}`));
      return;
    }

    if (ts.isPropertyDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
      addSymbol(node.name.text, 'property', node, container);
    }

    if (ts.isParameter(node) && node.name && ts.isIdentifier(node.name)) {
      addSymbol(node.name.text, 'parameter', node, container);
    }

    if (ts.isModuleDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
      addSymbol(node.name.text, 'module', node, container);
      ts.forEachChild(node, (child) => visit(child, node.name!.text));
      return;
    }

    if (ts.isExportSpecifier(node)) {
      exports.push({
        name: node.name.text,
        kind: 'named',
        range: nodeRange(sourceFile, node),
      });
    }

    ts.forEachChild(node, (child) => visit(child, container));
  }

  visit(sourceFile, undefined);

  return {
    path,
    language,
    symbols,
    imports,
    exports,
  };
}

export function parsePython(path: string, content: string): ParseResult {
  const lines = content.split(/\r?\n/);
  const symbols: CodeSymbol[] = [];
  const imports: ImportInfo[] = [];
  const exports: ExportInfo[] = [];

  const classPattern = /^\s*class\s+(\w+)\s*(?:\(|:)/;
  const functionPattern = /^(\s*)def\s+(\w+)\s*\(/;
  const importPattern = /^(?:from\s+(\S+)\s+)?import\s+(.+)$/;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) {
      continue;
    }

    const importMatch = importPattern.exec(trimmed);
    if (importMatch) {
      let source = importMatch[1] ?? '';
      const specPart = importMatch[2] ?? '';
      const specifiers = specPart
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const aliasMatch = /^(\w+)\s+as\s+(\w+)$/.exec(part);
          if (aliasMatch) {
            return { name: aliasMatch[2], alias: aliasMatch[1] };
          }
          return { name: part };
        });
      if (!source && specifiers.length > 0) {
        source = specifiers[0]!.name;
      }
      imports.push({
        source,
        specifiers,
        range: {
          startLine: i + 1,
          startColumn: 0,
          endLine: i + 1,
          endColumn: line.length,
        },
      });
      continue;
    }

    const classMatch = classPattern.exec(line);
    if (classMatch) {
      const indent = line.search(/\S/);
      const container = findContainer(symbols, indent, i + 1);
      symbols.push({
        name: classMatch[1],
        kind: 'class',
        path,
        range: {
          startLine: i + 1,
          startColumn: indent,
          endLine: i + 1,
          endColumn: line.length,
        },
        container,
      });
      continue;
    }

    const functionMatch = functionPattern.exec(line);
    if (functionMatch) {
      const indent = line.search(/\S/);
      const container = findContainer(symbols, indent, i + 1);
      const isMethod = Boolean(container);
      symbols.push({
        name: functionMatch[2],
        kind: isMethod ? 'method' : 'function',
        path,
        range: {
          startLine: i + 1,
          startColumn: indent,
          endLine: i + 1,
          endColumn: line.length,
        },
        container,
      });
      continue;
    }
  }

  return {
    path,
    language: 'python',
    symbols,
    imports,
    exports,
  };
}

function findContainer(symbols: CodeSymbol[], currentIndent: number, currentLine: number): string | undefined {
  let candidate: CodeSymbol | undefined;
  for (const symbol of symbols) {
    if (symbol.kind !== 'class' && symbol.kind !== 'function') {
      continue;
    }
    const symbolIndent = symbol.range.startColumn;
    if (symbol.range.startLine < currentLine && symbolIndent < currentIndent) {
      if (!candidate || symbolIndent > candidate.range.startColumn) {
        candidate = symbol;
      }
    }
  }
  return candidate?.name;
}

interface NodeWithModifiers {
  modifiers?: ts.NodeArray<ts.ModifierLike>;
}

function hasExportModifier(node: ts.Node): boolean {
  const withModifiers = node as unknown as NodeWithModifiers;
  if (!withModifiers.modifiers) {
    return false;
  }
  return withModifiers.modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function nodeRange(sourceFile: ts.SourceFile, node: ts.Node): CodeSymbolRange {
  const start = ts.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile));
  const end = ts.getLineAndCharacterOfPosition(sourceFile, node.getEnd());
  return {
    startLine: start.line + 1,
    startColumn: start.character,
    endLine: end.line + 1,
    endColumn: end.character,
  };
}

function extractSignature(content: string, node: ts.Node): string | undefined {
  if (!ts.isFunctionDeclaration(node) && !ts.isMethodDeclaration(node) && !ts.isArrowFunction(node)) {
    return undefined;
  }
  const text = node.getText();
  const firstBrace = text.indexOf('{');
  if (firstBrace === -1) {
    return text.trim();
  }
  return text.slice(0, firstBrace).trim();
}
