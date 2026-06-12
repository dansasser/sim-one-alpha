import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectPackageManager, type RepoPackageManager } from './package-manager.js';
import { createCodingVerificationPlan } from './verification.js';
import type { CodingVerificationCommand } from '../types.js';

export interface CodingRepoPreflight {
  repoPath: string;
  packageManager: RepoPackageManager;
  scripts: Record<string, string>;
  verificationPlan: CodingVerificationCommand[];
}

export function runCodingRepoPreflight(repoPath: string): CodingRepoPreflight {
  const packageManager = detectPackageManager(repoPath);
  const scripts = readPackageScripts(repoPath);

  return {
    repoPath,
    packageManager,
    scripts,
    verificationPlan: createCodingVerificationPlan({ packageManager, scripts }),
  };
}

export function readPackageScripts(repoPath: string): Record<string, string> {
  const packageJsonPath = join(repoPath, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return {};
  }
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    scripts?: Record<string, string>;
  };
  return packageJson.scripts ?? {};
}
