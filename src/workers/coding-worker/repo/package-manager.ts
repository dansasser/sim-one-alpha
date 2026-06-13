import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type RepoPackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun' | 'unknown';

export function detectPackageManager(repoPath: string): RepoPackageManager {
  if (existsSync(join(repoPath, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (existsSync(join(repoPath, 'package-lock.json'))) {
    return 'npm';
  }
  if (existsSync(join(repoPath, 'yarn.lock'))) {
    return 'yarn';
  }
  if (existsSync(join(repoPath, 'bun.lockb')) || existsSync(join(repoPath, 'bun.lock'))) {
    return 'bun';
  }
  return 'unknown';
}

export function packageManagerRunCommand(packageManager: RepoPackageManager, script: string): string {
  switch (packageManager) {
    case 'pnpm':
      return `corepack pnpm run ${script}`;
    case 'npm':
      return `npm run ${script}`;
    case 'yarn':
      return `yarn ${script}`;
    case 'bun':
      return `bun run ${script}`;
    case 'unknown':
      throw new Error(`Cannot build run command for unknown package manager (script: ${script}).`);
  }
}

export function packageManagerTestCommand(packageManager: RepoPackageManager): string {
  switch (packageManager) {
    case 'pnpm':
      return 'corepack pnpm test';
    case 'npm':
      return 'npm test';
    case 'yarn':
      return 'yarn test';
    case 'bun':
      return 'bun test';
    case 'unknown':
      throw new Error('Cannot build test command for unknown package manager.');
  }
}
