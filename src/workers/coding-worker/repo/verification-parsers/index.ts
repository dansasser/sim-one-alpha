import type { CodingTestFailure, CodingVerificationCommand } from '../../types.js';
import { jestVitestParserName, parseJestOrVitestFailures } from './jest-vitest.js';
import { pytestParserName, parsePytestFailures } from './pytest.js';
import { tscParserName, parseTscFailures } from './tsc.js';

export type VerificationParserName = typeof jestVitestParserName | typeof pytestParserName | typeof tscParserName;

export interface VerificationParserResult {
  parser: VerificationParserName;
  failures: CodingTestFailure[];
}

export function detectVerificationParser(command: CodingVerificationCommand): VerificationParserName | undefined {
  const commandString = command.command.toLowerCase();
  if (command.name === 'typecheck' || /tsc\s+(?:-p\s+[^\s]+\s+)?--noemit/.test(commandString) || /tsc\b/.test(commandString)) {
    return tscParserName;
  }
  if (command.name === 'test:unit' || command.name === 'test' || /jest\b/.test(commandString) || /vitest\b/.test(commandString)) {
    return jestVitestParserName;
  }
  if (/pytest\b/.test(commandString) || /py\.test\b/.test(commandString)) {
    return pytestParserName;
  }
  return undefined;
}

export function parseVerificationCommandFailures(
  command: CodingVerificationCommand,
  stdout: string,
  stderr: string,
): VerificationParserResult | undefined {
  const parserName = detectVerificationParser(command);
  if (!parserName) {
    return undefined;
  }

  const output = `${stdout}\n${stderr}`.trim();
  switch (parserName) {
    case jestVitestParserName:
      return { parser: parserName, failures: parseJestOrVitestFailures(output) };
    case pytestParserName:
      return { parser: parserName, failures: parsePytestFailures(output) };
    case tscParserName:
      return { parser: parserName, failures: parseTscFailures(output) };
    default:
      return undefined;
  }
}
