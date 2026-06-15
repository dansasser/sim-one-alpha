import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { glob } from 'node:fs/promises';
import { collectAsyncIterator } from './iterator-helper.js';
import type { VectorRecord } from '../vector/index.js';
import { chunkText } from './chunker.js';

export interface KnowledgeDocIndexerOptions {
  projectRoot: string;
  include?: string[];
  exclude?: string[];
}

const defaultInclude = [
  'docs/architecture/**/*.md',
  'src/workspace/**/*.md',
  'README.md',
];
const defaultExclude = ['**/node_modules/**', '**/.git/**', '**/dist/**'];

export async function indexKnowledgeDocs(options: KnowledgeDocIndexerOptions): Promise<VectorRecord[]> {
  const include = options.include ?? defaultInclude;
  const exclude = options.exclude ?? defaultExclude;
  const records: VectorRecord[] = [];

  for (const pattern of include) {
    const paths = await collectAsyncIterator(glob(pattern, {
      cwd: options.projectRoot,
      exclude,
    }));

    for (const filePath of paths) {
      const absolutePath = resolve(options.projectRoot, filePath);
      const chunks = await indexDoc(absolutePath, filePath, options.projectRoot);
      records.push(...chunks);
    }
  }

  return records;
}

async function indexDoc(absolutePath: string, relativePath: string, projectRoot: string): Promise<VectorRecord[]> {
  try {
    const content = await readFile(absolutePath, 'utf8');
    if (!content.trim()) {
      return [];
    }

    const chunks = chunkText(content, relativePath, { targetTokens: 768, overlapTokens: 128 });
    const contentHash = createHash('sha256').update(content).digest('hex');
    const updatedAt = new Date().toISOString();

    return chunks.map((chunk): VectorRecord => ({
      id: chunk.id,
      chunk_key: chunk.id,
      source: 'knowledge_doc',
      title: chunk.title,
      content: chunk.content,
      vector: [],
      metadata: {
        projectRoot,
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
    console.error(
      '[WARN] Failed to index knowledge doc',
      relativePath,
      ':',
      error instanceof Error ? error.message : String(error),
    );
    return [];
  }
}
