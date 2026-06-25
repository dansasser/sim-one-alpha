import { extname, join } from 'node:path';

export interface ImportGraphNode {
  path: string;
  outgoing: ImportGraphEdge[];
  incoming: ImportGraphEdge[];
}

export interface ImportGraphEdge {
  source: string;
  target: string;
  importNames: string[];
  isReExport: boolean;
}

export interface ImportGraph {
  nodes: Map<string, ImportGraphNode>;
  internalPaths: Set<string>;
}

export interface ImportGraphInput {
  path: string;
  imports: { source: string; specifiers: { name: string }[] }[];
  exports: { name: string; kind: string; source?: string }[];
}

export function createImportGraph(): ImportGraph {
  return { nodes: new Map(), internalPaths: new Set() };
}

export function addToImportGraph(graph: ImportGraph, input: ImportGraphInput): void {
  const node = getOrCreateNode(graph, input.path);
  graph.internalPaths.add(input.path);
  for (const importItem of input.imports) {
    const resolved = resolveImportSource(input.path, importItem.source);
    if (isInternalImportSource(importItem.source)) {
      graph.internalPaths.add(input.path);
      graph.internalPaths.add(resolved);
    }
    const edge: ImportGraphEdge = {
      source: input.path,
      target: resolved,
      importNames: importItem.specifiers.map((s) => s.name),
      isReExport: false,
    };
    node.outgoing.push(edge);
    getOrCreateNode(graph, resolved).incoming.push(edge);
  }

  for (const exportItem of input.exports) {
    if (exportItem.source) {
      const resolved = resolveImportSource(input.path, exportItem.source);
      if (isInternalImportSource(exportItem.source)) {
        graph.internalPaths.add(input.path);
        graph.internalPaths.add(resolved);
      }
      const edge: ImportGraphEdge = {
        source: input.path,
        target: resolved,
        importNames: exportItem.name === '*' ? [] : [exportItem.name],
        isReExport: true,
      };
      node.outgoing.push(edge);
      getOrCreateNode(graph, resolved).incoming.push(edge);
    }
  }
}

export function findDependencies(graph: ImportGraph, path: string): string[] {
  const node = graph.nodes.get(path);
  if (!node) {
    return [];
  }
  return [...new Set(node.outgoing.map((edge) => edge.target))];
}

export function findDependents(graph: ImportGraph, path: string): string[] {
  const node = graph.nodes.get(path);
  if (!node) {
    return [];
  }
  return [...new Set(node.incoming.map((edge) => edge.source))];
}

export function findImportPath(graph: ImportGraph, fromPath: string, toPath: string): string[] | undefined {
  const visited = new Set<string>();
  const queue: Array<{ path: string; chain: string[] }> = [{ path: fromPath, chain: [fromPath] }];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.path === toPath) {
      return current.chain;
    }
    if (visited.has(current.path)) {
      continue;
    }
    visited.add(current.path);

    const node = graph.nodes.get(current.path);
    if (!node) {
      continue;
    }
    for (const edge of node.outgoing) {
      if (!visited.has(edge.target)) {
        queue.push({ path: edge.target, chain: [...current.chain, edge.target] });
      }
    }
  }

  return undefined;
}

function getOrCreateNode(graph: ImportGraph, path: string): ImportGraphNode {
  const existing = graph.nodes.get(path);
  if (existing) {
    return existing;
  }
  const node: ImportGraphNode = { path, outgoing: [], incoming: [] };
  graph.nodes.set(path, node);
  return node;
}

function isInternalImportSource(source: string): boolean {
  return source.startsWith('.');
}

function resolveImportSource(fromPath: string, source: string): string {
  if (!isInternalImportSource(source)) {
    return source;
  }
  const dir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
  const base = join(dir, source);
  const ext = extname(base).toLowerCase();
  if (ext) {
    return base;
  }
  const isTypeScript = /\.(ts|tsx|mts|cts)$/i.test(fromPath);
  if (isTypeScript) {
    return `${base}.ts`;
  }
  return base;
}

export function collapseExternalImports(graph: ImportGraph): ImportGraph {
  const collapsed = createImportGraph();
  for (const [path, node] of graph.nodes.entries()) {
    if (!graph.internalPaths.has(path)) {
      continue;
    }
    const filteredOutgoing = node.outgoing.filter((edge) => graph.internalPaths.has(edge.target));
    const filteredIncoming = node.incoming.filter((edge) => graph.internalPaths.has(edge.source));
    collapsed.nodes.set(path, {
      path,
      outgoing: filteredOutgoing,
      incoming: filteredIncoming,
    });
    collapsed.internalPaths.add(path);
  }

  return collapsed;
}
