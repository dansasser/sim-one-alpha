import type { CodingTestFailure } from '../../../../../engine/workers/coding-worker/types.js';

export const pytestParserName = 'pytest';

function normalizeOutput(output: string): string[] {
  return output.split(/\r?\n/);
}

function extractFunctionName(testHeader: string): string | undefined {
  // pytest headers are wrapped in underscores: "____ test_answer ____"
  const match = testHeader.match(/^[_=]+\s*(\S+)\s*[_=]+$/);
  return match?.[1];
}

function parsePytestLocation(locationLine: string): { file: string; line?: number } | undefined {
  // "src/test_sample.py:4: AssertionError"
  const match = locationLine.match(/^\s*([A-Za-z0-9_./~\\-]+:\d+(?::\d+)?)\s*:/);
  if (!match) {
    return undefined;
  }
  const fileParts = match[1].split(':');
  return { file: fileParts[0], line: fileParts[1] ? Number(fileParts[1]) : undefined };
}

function extractMessageFromBlock(block: string[]): string {
  // Prefer the first line starting with "E       " that contains the assertion detail.
  for (const line of block) {
    const trimmed = line.trim();
    if (trimmed.startsWith('E ')) {
      const detail = line.replace(/^\s*E\s+/, '').trim();
      if (detail) {
        return detail;
      }
    }
  }
  // Fall back to any non-empty line that is not a code line or location.
  for (const line of block) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith('>') || /^\s+\d+\s+/.test(line)) {
      continue;
    }
    if (trimmed.includes('.py:') && trimmed.includes(':')) {
      continue;
    }
    return trimmed;
  }
  return 'pytest assertion failed';
}

function extractContextBlock(lines: string[], startIndex: number): { block: string[]; nextIndex: number } {
  const block: string[] = [];
  let i = startIndex;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('=====') || line.startsWith('_____') || line.startsWith('FAIL ')) {
      break;
    }
    block.push(line);
    i += 1;
  }
  return { block, nextIndex: i };
}

export function parsePytestFailures(output: string): CodingTestFailure[] {
  const lines = normalizeOutput(output);
  const failures: CodingTestFailure[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const headerMatch = line.match(/^____[_=]+\s*(\S+)\s*[_=]+____\s*$/);
    if (!headerMatch) {
      i += 1;
      continue;
    }

    const functionName = headerMatch[1];
    const { block, nextIndex } = extractContextBlock(lines, i + 1);
    i = nextIndex;

    let file: string | undefined;
    let lineNumber: number | undefined;
    let context = block.join('\n').trim();

    for (const blockLine of block) {
      const location = parsePytestLocation(blockLine);
      if (location) {
        file = location.file;
        lineNumber = location.line;
        break;
      }
    }

    // If no location line, look for a code-frame file reference.
    if (!file) {
      for (const blockLine of block) {
        const frameMatch = blockLine.match(/^\s*>\s*\S+\s+([A-Za-z0-9_./~\\-]+:\d+)\s*/);
        if (frameMatch) {
          const parts = frameMatch[1].split(':');
          file = parts[0];
          lineNumber = parts[1] ? Number(parts[1]) : undefined;
          break;
        }
      }
    }

    failures.push({
      file: file ?? 'unknown',
      line: lineNumber,
      message: extractMessageFromBlock(block),
      functionName,
      context,
      severity: 'error',
    });
  }

  return failures;
}
