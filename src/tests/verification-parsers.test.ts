import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  detectVerificationParser,
  parseVerificationCommandFailures,
} from '../engine/workers/coding-worker/repo/verification.js';
import { parseJestOrVitestFailures } from '../engine/workers/coding-worker/repo/verification-parsers/jest-vitest.js';
import { parsePytestFailures } from '../engine/workers/coding-worker/repo/verification-parsers/pytest.js';
import { parseTscFailures } from '../engine/workers/coding-worker/repo/verification-parsers/tsc.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = currentDir.includes('.tmp/tsc')
  ? dirname(dirname(dirname(currentDir)))
  : dirname(dirname(currentDir));
const fixturesDir = join(projectRoot, 'src', 'tests', 'fixtures', 'verification-parsers');

function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8');
}

test('jest parser extracts file, line, test name and message', () => {
  const output = loadFixture('jest-failure.txt');
  const failures = parseJestOrVitestFailures(output);

  assert.equal(failures.length, 1);
  const failure = failures[0];
  assert.equal(failure.file, 'src/sum.test.js');
  assert.equal(failure.line, 3);
  assert.equal(failure.column, 5);
  assert.equal(failure.testName, "adds 1 + 2 to equal 3");
  assert.match(failure.message ?? '', /Object\.is equality|Expected: 3/);
  assert.equal(failure.severity, 'error');
  assert.ok(failure.context?.includes('expect(sum(1, 2)).toBe(3)'));
});

test('vitest parser extracts file, line, nested test name and message', () => {
  const output = loadFixture('vitest-failure.txt');
  const failures = parseJestOrVitestFailures(output);

  assert.equal(failures.length, 1);
  const failure = failures[0];
  assert.equal(failure.file, 'src/utils.test.ts');
  assert.equal(failure.line, 3);
  assert.equal(failure.column, 5);
  assert.equal(failure.testName, 'my test > adds 1 + 2 to equal 3');
  assert.match(failure.message ?? '', /expected 2 to be 3|AssertionError/);
  assert.equal(failure.severity, 'error');
});

test('pytest parser extracts file, line, function and assertion message', () => {
  const output = loadFixture('pytest-failure.txt');
  const failures = parsePytestFailures(output);

  assert.equal(failures.length, 1);
  const failure = failures[0];
  assert.equal(failure.file, 'src/test_sample.py');
  assert.equal(failure.line, 4);
  assert.equal(failure.functionName, 'test_answer');
  assert.match(failure.message ?? '', /assert 4 == 5/);
  assert.equal(failure.severity, 'error');
  assert.ok(failure.context?.includes('assert inc(3) == 5'));
});

test('tsc parser extracts file, line, code and message for both output styles', () => {
  const output = loadFixture('tsc-failure.txt');
  const failures = parseTscFailures(output);

  assert.equal(failures.length, 2);
  const first = failures[0];
  assert.equal(first.file, 'src/index.ts');
  assert.equal(first.line, 10);
  assert.equal(first.column, 5);
  assert.equal(first.code, 'TS2345');
  assert.match(first.message, /Argument of type 'string' is not assignable to parameter of type 'number'/);
  assert.equal(first.severity, 'error');

  const second = failures[1];
  assert.equal(second.file, 'src/utils.ts');
  assert.equal(second.line, 15);
  assert.equal(second.column, 3);
  assert.equal(second.code, 'TS2322');
});

test('verification parser router detects jest, vitest, pytest and tsc commands', () => {
  assert.equal(
    detectVerificationParser({ name: 'test:unit', command: 'vitest run', required: true, reason: '', status: 'pending' }),
    'jest-vitest',
  );
  assert.equal(
    detectVerificationParser({ name: 'test', command: 'jest', required: true, reason: '', status: 'pending' }),
    'jest-vitest',
  );
  assert.equal(
    detectVerificationParser({ name: 'typecheck', command: 'tsc -p tsconfig.json --noEmit', required: true, reason: '', status: 'pending' }),
    'tsc',
  );
  assert.equal(
    detectVerificationParser({ name: 'python-test', command: 'pytest tests/', required: true, reason: '', status: 'pending' }),
    'pytest',
  );
  assert.equal(
    detectVerificationParser({ name: 'custom', command: 'node custom-check.js', required: true, reason: '', status: 'pending' }),
    undefined,
  );
});

test('parseVerificationCommandFailures routes by command name and attaches parser metadata', () => {
  const output = loadFixture('tsc-failure.txt');
  const result = parseVerificationCommandFailures(
    { name: 'typecheck', command: 'tsc -p tsconfig.json --noEmit', required: true, reason: '', status: 'pending' },
    output,
    '',
  );

  assert.ok(result);
  assert.equal(result?.parser, 'tsc');
  assert.equal(result?.failures.length, 2);
});

test('parseVerificationCommandFailures returns undefined for unrecognized commands', () => {
  const result = parseVerificationCommandFailures(
    { name: 'custom', command: 'node custom-check.js', required: true, reason: '', status: 'pending' },
    'error!',
    '',
  );

  assert.equal(result, undefined);
});
