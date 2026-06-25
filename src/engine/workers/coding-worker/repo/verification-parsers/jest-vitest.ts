import type { CodingTestFailure } from '../../../../../engine/workers/coding-worker/types.js';

export const jestVitestParserName = 'jest-vitest';

function normalizeOutput(output: string): string[] {
  return output.split(/\r?\n/);
}

function parseLocation(location: string): { file: string; line?: number; column?: number } | undefined {
  // Jest stack: at Object.<anonymous> (src/sum.test.js:3:5)
  // Vitest stack: at src/sum.test.js:3:5
  // Standalone: src/sum.test.js:3:5
  const match = location.match(/\(?([^:\(\)\n]+):(\d+)(?::(\d+))?\)?\s*$/);
  if (!match) {
    return undefined;
  }
  let file = match[1].trim();
  file = file.replace(/^[❯›>\s]+/, '');
  const line = Number(match[2]);
  const column = match[3] ? Number(match[3]) : undefined;
  if (!file) {
    return undefined;
  }
  return { file, line, column };
}

function isBlockBoundary(line: string): boolean {
  return (
    /^\s*(FAIL |PASS |Test Suites:|Tests:|Test Files)/.test(line) ||
    /^\s*[✕●]\s+/.test(line) ||
    /^____[_=]+\s*\S+\s*[_=]+____\s*$/.test(line) // pytest-style header
  );
}

function extractContextBlock(lines: string[], startIndex: number): { context: string; nextIndex: number } {
  const block: string[] = [];
  let i = startIndex;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlockBoundary(line)) {
      break;
    }
    // For Jest, a deeply indented test marker that is not the first line indicates a new test case.
    if (/^\s+[✕●]\s+/.test(line) && block.length > 0) {
      break;
    }
    block.push(line);
    i += 1;
  }
  return { context: block.join('\n').trim(), nextIndex: i };
}

function parseJestFailures(output: string): CodingTestFailure[] {
  const lines = normalizeOutput(output);
  const failures: CodingTestFailure[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const failMatch = line.match(/^\s*FAIL\s+(.+)$/);
    if (!failMatch) {
      i += 1;
      continue;
    }
    const suiteFile = failMatch[1].trim();
    i += 1;

    // Find test cases in this suite block.
    while (i < lines.length) {
      const current = lines[i];
      if (current.startsWith('FAIL ') || current.startsWith('PASS ') || current.startsWith('Test Suites:')) {
        break;
      }

      // Jest test name: "  ✕ adds 1 + 2 to equal 3 (5 ms)" or "  ● adds 1 + 2 to equal 3"
      const testMatch = current.match(/^\s*[✕●]\s+(.+?)\s*(?:\(\d+\s*ms\))?\s*$/);
      if (testMatch) {
        const testName = testMatch[1].trim();
        const { context, nextIndex } = extractContextBlock(lines, i + 1);
        i = nextIndex;
        const location = findLocationInContext(context, suiteFile);
        failures.push({
          file: location?.file ?? suiteFile,
          line: location?.line,
          column: location?.column,
          message: extractMessage(context),
          testName,
          context,
          severity: 'error',
        });
        continue;
      }

      // Suite-level failure: "  ● Test suite failed to run"
      const suiteFailMatch = current.match(/^\s*●\s+Test suite failed to run\s*$/);
      if (suiteFailMatch) {
        const { context, nextIndex } = extractContextBlock(lines, i + 1);
        i = nextIndex;
        const location = findLocationInContext(context, suiteFile);
        failures.push({
          file: location?.file ?? suiteFile,
          line: location?.line,
          column: location?.column,
          message: extractMessage(context),
          context,
          severity: 'error',
        });
        continue;
      }

      i += 1;
    }
  }

  return failures;
}

function parseVitestFailures(output: string): CodingTestFailure[] {
  const lines = normalizeOutput(output);
  const failures: CodingTestFailure[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    // Vitest: " FAIL  src/utils.test.ts > my test > adds 1 + 2 to equal 3"
    const failMatch = line.match(/^\s*FAIL\s+(.+)$/);
    if (!failMatch) {
      i += 1;
      continue;
    }
    const suiteAndTest = failMatch[1].trim();
    const parts = suiteAndTest.split(/\s+>\s+/);
    const suiteFile = parts[0].trim();
    const testName = parts.length > 1 ? parts.slice(1).join(' > ') : undefined;
    i += 1;

    const { context, nextIndex } = extractContextBlock(lines, i);
    i = nextIndex;
    const location = findLocationInContext(context, suiteFile);
    failures.push({
      file: location?.file ?? suiteFile,
      line: location?.line,
      column: location?.column,
      message: extractMessage(context),
      testName,
      context,
      severity: 'error',
    });
  }

  return failures;
}

function findLocationInContext(context: string, fallbackFile: string): { file: string; line?: number; column?: number } | undefined {
  if (!context) {
    return { file: fallbackFile };
  }
  const lines = context.split('\n');
  for (const line of lines) {
    // Code frame arrow line: "> 3 |     expect(sum(1, 2)).toBe(3);"
    const frameMatch = line.match(/^\s*>\s*(\d+)\s*[|│]\s*.+$/);
    if (frameMatch) {
      const lineNumber = Number(frameMatch[1]);
      // Find the file in the closest stack line above or below.
      const stackLine = lines.find((l) => /\s*at\s+.+\([^)]+:\d+(:\d+)?\)/.test(l) || / ❯ .+:\d+/.test(l));
      if (stackLine) {
        const location = parseLocation(stackLine);
        if (location) {
          return { file: location.file, line: lineNumber, column: location.column };
        }
      }
      return { file: fallbackFile, line: lineNumber };
    }
  }
  for (const line of lines) {
    const location = parseLocation(line);
    if (location) {
      return location;
    }
  }
  return { file: fallbackFile };
}

function extractMessage(context: string): string {
  const lines = context.split('\n').map((l) => l.trimEnd());
  // First non-empty line that is not a code frame, stack, or test marker.
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (/^\d+\s*[|│]/.test(trimmed) || /^>\s*\d+/.test(trimmed)) {
      continue;
    }
    if (/^at\s+/.test(trimmed) || /❯/.test(trimmed)) {
      continue;
    }
    if (trimmed.startsWith('Expected:') || trimmed.startsWith('Received:') || trimmed.startsWith('expect(')) {
      return trimmed;
    }
    if (['AssertionError:', 'TypeError:', 'Error:', 'ReferenceError:'].some((prefix) => trimmed.startsWith(prefix))) {
      return trimmed;
    }
    return trimmed;
  }
  return 'Test failure';
}

export function parseJestOrVitestFailures(output: string): CodingTestFailure[] {
  const normalized = output;
  // Vitest usually prints "FAIL  file > test > name" with angle-bracket separators.
  const isVitest = /^\s*FAIL\s+.+\s+>\s+.+$/m.test(normalized);
  if (isVitest) {
    return parseVitestFailures(normalized);
  }
  return parseJestFailures(normalized);
}
