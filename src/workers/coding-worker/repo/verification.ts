import type { CodingVerificationCommand, VerificationStatus } from '../types.js';
import {
  packageManagerRunCommand,
  packageManagerTestCommand,
  type RepoPackageManager,
} from './package-manager.js';

export interface VerificationPlanInput {
  packageManager: RepoPackageManager;
  scripts: Record<string, string>;
  changedFiles?: string[];
}

export function createCodingVerificationPlan(input: VerificationPlanInput): CodingVerificationCommand[] {
  const commands: CodingVerificationCommand[] = [];
  if (input.packageManager === 'unknown') {
    return commands;
  }

  const addScript = (name: string, reason: string, required = true) => {
    if (input.scripts[name]) {
      commands.push(createCommand(name, packageManagerRunCommand(input.packageManager, name), reason, required));
    }
  };

  if (input.scripts['test:unit']) {
    commands.push(
      createCommand(
        'test:unit',
        packageManagerRunCommand(input.packageManager, 'test:unit'),
        'Focused unit tests should run before the full suite when code changes are made.',
        false,
      ),
    );
  }

  addScript('typecheck', 'TypeScript changes require the configured typecheck script.');
  addScript('build', 'Build verification catches Flue packaging and emitted runtime regressions.');

  if (input.scripts.test) {
    commands.push(
      createCommand(
        'test',
        packageManagerTestCommand(input.packageManager),
        'The full configured test script is required before claiming coding work is complete.',
        true,
      ),
    );
  }

  addScript('lint', 'Run the named lint script exactly as configured when present.');
  addScript('check', 'Run the named check script exactly as configured when present.');

  return commands;
}

export function hasPassingRequiredVerification(commands: CodingVerificationCommand[]): boolean {
  const required = commands.filter((command) => command.required);
  return required.length > 0 && required.every((command) => command.status === 'passed');
}

function createCommand(
  name: string,
  command: string,
  reason: string,
  required: boolean,
  status: VerificationStatus = 'pending',
): CodingVerificationCommand {
  return {
    name,
    command,
    reason,
    required,
    status,
  };
}
