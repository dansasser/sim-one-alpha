import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';
import { glob } from 'node:fs/promises';
import { collectAsyncIterator } from './iterator-helper.js';
import type { VectorRecord } from '../vector/index.js';
import { chunkText, type TextChunk } from './chunker.js';

export interface ProjectFileIndexerOptions {
  workspaceRoot: string;
  include?: string[];
  exclude?: string[];
}

const defaultInclude = ['**/*.{ts,js,mjs,cjs,md,json,txt,yaml,yml,py,astro,html,css,scss,sql}'];
const defaultExclude = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/.tmp/**', '**/.gorombo/**'];

export async function indexProjectFiles(options: ProjectFileIndexerOptions): Promise<VectorRecord[]> {
  const include = options.include ?? defaultInclude;
  const exclude = options.exclude ?? defaultExclude;
  const records: VectorRecord[] = [];

  for (const pattern of include) {
    const paths = await collectAsyncIterator(glob(pattern, {
      cwd: options.workspaceRoot,
      exclude,
    }));

    for (const filePath of paths) {
      const absolutePath = resolve(options.workspaceRoot, filePath);
      const chunks = await indexFile(absolutePath, filePath, options.workspaceRoot);
      records.push(...chunks);
    }
  }

  return records;
}

async function indexFile(absolutePath: string, relativePath: string, workspaceRoot: string): Promise<VectorRecord[]> {
  try {
    const content = await readFile(absolutePath, 'utf8');
    if (!content.trim()) {
      return [];
    }

    const chunks = chunkText(content, relativePath);
    const contentHash = createHash('sha256').update(content).digest('hex');
    const updatedAt = new Date().toISOString();

    return chunks.map((chunk): VectorRecord => ({
      id: chunk.id,
      chunk_key: chunk.id,
      source: 'project_file',
      title: chunk.title,
      content: chunk.content,
      vector: [],
      metadata: {
        workspaceRoot,
        relativePath,
        absolutePath,
        contentHash,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        chunkIndex: chunk.metadata.chunkIndex,
      },
      updated_at: updatedAt,
    }));
  } catch (error) {
    // Skip unreadable files without failing the whole indexing run.
    console.error(
      '[WARN] Failed to index project file',
      relativePath,
      ':',
      error instanceof Error ? error.message : String(error),
    );
    return [];
  }
}

export function isTextFile(filePath: string): boolean {
  const extension = extname(filePath).toLowerCase();
  const textExtensions = new Set([
    '.ts', '.js', '.mjs', '.cjs', '.json', '.md', '.txt', '.yaml', '.yml', '.py',
    '.astro', '.html', '.css', '.scss', '.sql', '.toml', '.ini', '.sh', '.ps1',
  ]);
  return textExtensions.has(extension);
}
