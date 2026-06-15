import { estimateTextTokens } from '../../session/context-budget.js';

export interface ChunkerOptions {
  targetTokens?: number;
  overlapTokens?: number;
}

export interface TextChunk {
  id: string;
  source: string;
  title: string;
  content: string;
  startLine?: number;
  endLine?: number;
  metadata: Record<string, unknown>;
}

const defaultTargetTokens = 512;
const defaultOverlapTokens = 128;

export function chunkText(
  text: string,
  source: string,
  options: ChunkerOptions = {},
): TextChunk[] {
  const targetTokens = readPositiveInteger(options.targetTokens) ?? defaultTargetTokens;
  const overlapTokens = readPositiveInteger(options.overlapTokens) ?? defaultOverlapTokens;
  const targetChars = Math.max(1, targetTokens * 4);
  const overlapChars = Math.max(0, overlapTokens * 4);

  if (text.length <= targetChars) {
    return [
      {
        id: hashChunk(source, text),
        source,
        title: source,
        content: text,
        metadata: {},
      },
    ];
  }

  const chunks: TextChunk[] = [];
  let start = 0;
  let chunkIndex = 0;

  while (start < text.length) {
    const end = Math.min(text.length, start + targetChars);
    const content = text.slice(start, end);
    const lineInfo = calculateLineRange(text, start, end);

    chunks.push({
      id: hashChunk(source, `${chunkIndex}:${content}`),
      source,
      title: `${source} (chunk ${chunkIndex + 1})`,
      content,
      startLine: lineInfo.startLine,
      endLine: lineInfo.endLine,
      metadata: {
        chunkIndex,
      },
    });

    if (end >= text.length) {
      break;
    }

    start = Math.max(start + 1, end - overlapChars);
    chunkIndex += 1;
  }

  return chunks;
}

function calculateLineRange(text: string, start: number, end: number): { startLine: number; endLine: number } {
  let startLine = 1;
  let endLine = 1;

  for (let index = 0; index < text.length && index < start; index += 1) {
    if (text[index] === '\n') {
      startLine += 1;
    }
  }

  endLine = startLine;
  for (let index = start; index < text.length && index < end; index += 1) {
    if (text[index] === '\n') {
      endLine += 1;
    }
  }

  return { startLine, endLine };
}

function hashChunk(source: string, content: string): string {
  const encoder = new TextEncoder();
  const data = encoder.encode(`${source}\0${content}`);
  let hash = 0;

  for (let index = 0; index < data.length; index += 1) {
    const byte = data[index];
    hash = (hash << 5) - hash + byte;
    hash |= 0;
  }

  return `${Math.abs(hash).toString(16)}`;
}

function readPositiveInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
  }

  return undefined;
}

export function estimateChunkTokens(chunk: TextChunk): number {
  return estimateTextTokens(chunk.content);
}
