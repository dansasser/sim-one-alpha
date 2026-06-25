import type { CodingTestFailure } from '../../../../../engine/workers/coding-worker/types.js';

export const tscParserName = 'tsc';

function normalizeOutput(output: string): string[] {
  return output.split(/\r?\n/);
}

export function parseTscFailures(output: string): CodingTestFailure[] {
  const lines = normalizeOutput(output);
  const failures: CodingTestFailure[] = [];

  for (const line of lines) {
    // Match TypeScript error lines like:
    // src/index.ts(10,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.
    // src/index.ts:10:5 - error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.
    const match = line.match(/^\s*([^:\(\s]*(?::(?!\d)[^:\(\s]*)*)(?:\((\d+),(\d+)\)|:(\d+):(\d+))?\s*[-:]\s*(error|warning)\s+(TS\d+):\s*(.+)\s*$/);
    if (!match) {
      continue;
    }

    const file = match[1].trim();
    const lineNumber = match[2] ? Number(match[2]) : match[4] ? Number(match[4]) : undefined;
    const column = match[3] ? Number(match[3]) : match[5] ? Number(match[5]) : undefined;
    const kind = match[6] as 'error' | 'warning';
    const code = match[7];
    const message = match[8].trim();

    failures.push({
      file,
      line: lineNumber,
      column,
      message,
      code,
      severity: kind === 'warning' ? 'warning' : 'error',
      context: line,
    });
  }

  return failures;
}
