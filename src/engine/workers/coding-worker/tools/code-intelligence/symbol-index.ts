import type { CodeSymbol, CodeSymbolRange } from '../../../../../engine/workers/coding-worker/tools/code-intelligence/ast-parser.js';

export interface SymbolLocation {
  path: string;
  name: string;
  kind: string;
  range: CodeSymbolRange;
  container?: string;
  signature?: string;
}

export interface SymbolIndex {
  declarations: Map<string, SymbolLocation[]>;
  references: Map<string, SymbolLocation[]>;
}

export interface BuildIndexInput {
  path: string;
  content: string;
}

export function createSymbolIndex(): SymbolIndex {
  return {
    declarations: new Map(),
    references: new Map(),
  };
}

export function addToSymbolIndex(
  index: SymbolIndex,
  parsed: { path: string; symbols: CodeSymbol[] },
  content: string,
): void {
  const lines = content.split(/\r?\n/);

  for (const symbol of parsed.symbols) {
    const location: SymbolLocation = {
      path: parsed.path,
      name: symbol.name,
      kind: symbol.kind,
      range: symbol.range,
      container: symbol.container,
      signature: symbol.signature,
    };

    const declList = index.declarations.get(symbol.name) ?? [];
    declList.push(location);
    index.declarations.set(symbol.name, declList);
  }

  for (const symbol of parsed.symbols) {
    const name = symbol.name;
    const referenceRanges = findOccurrences(lines, name, symbol.path);
    const refList = index.references.get(name) ?? [];
    const declarationRange = symbol.nameRange ?? symbol.range;
    for (const range of referenceRanges) {
      if (rangeMatches(range, declarationRange)) {
        continue;
      }
      refList.push({
        path: symbol.path,
        name,
        kind: 'reference',
        range,
      });
    }
    index.references.set(name, refList);
  }
}

export function findDeclarations(index: SymbolIndex, symbolName: string): SymbolLocation[] {
  return index.declarations.get(symbolName) ?? [];
}

export function findReferences(index: SymbolIndex, symbolName: string): SymbolLocation[] {
  return index.references.get(symbolName) ?? [];
}

function findOccurrences(lines: string[], name: string, path: string): SymbolLocation['range'][] {
  const ranges: SymbolLocation['range'][] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    let index = line.indexOf(name);
    while (index !== -1) {
      const before = index > 0 ? line[index - 1] : ' ';
      const after = index + name.length < line.length ? line[index + name.length] : ' ';
      const isWordChar = (c: string) => /[a-zA-Z0-9_$]/.test(c);
      if (!isWordChar(before) && !isWordChar(after)) {
        ranges.push({
          startLine: i + 1,
          startColumn: index,
          endLine: i + 1,
          endColumn: index + name.length,
        });
      }
      index = line.indexOf(name, index + 1);
    }
  }
  return ranges;
}

function rangeMatches(left: SymbolLocation['range'], right: SymbolLocation['range']): boolean {
  return (
    left.startLine === right.startLine &&
    left.startColumn === right.startColumn &&
    left.endLine === right.endLine &&
    left.endColumn === right.endColumn
  );
}
