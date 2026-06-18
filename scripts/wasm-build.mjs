import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const pm = detectPackageManager(repoRoot);
const crateDir = resolve(repoRoot, 'crates', 'gorombo-memory');

if (!existsSync(crateDir)) {
  throw new Error(`Rust crate directory is missing: ${crateDir}`);
}

const { command, args } = buildWasmPackInvocation(pm, crateDir);

const result = spawnSync(command, args, {
  cwd: repoRoot,
  stdio: 'inherit',
  shell: false,
});

if (result.error) {
  throw result.error;
}

if (typeof result.status === 'number' && result.status !== 0) {
  process.exit(result.status);
}

if (result.signal) {
  throw new Error(`wasm-pack exited from signal ${result.signal}`);
}

function detectPackageManager(repoPath) {
  if (existsSync(resolve(repoPath, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (existsSync(resolve(repoPath, 'package-lock.json'))) {
    return 'npm';
  }
  if (existsSync(resolve(repoPath, 'yarn.lock'))) {
    return 'yarn';
  }
  if (existsSync(resolve(repoPath, 'bun.lockb')) || existsSync(resolve(repoPath, 'bun.lock'))) {
    return 'bun';
  }
  return 'unknown';
}

function buildWasmPackInvocation(packageManager, crateDir) {
  switch (packageManager) {
    case 'pnpm':
      return {
        command: 'pnpm',
        args: ['exec', 'wasm-pack', 'build', crateDir, '--target', 'nodejs', '--out-dir', 'pkg'],
      };
    case 'npm':
      return {
        command: 'npx',
        args: ['wasm-pack', 'build', crateDir, '--target', 'nodejs', '--out-dir', 'pkg'],
      };
    case 'yarn':
      return {
        command: 'yarn',
        args: ['exec', 'wasm-pack', 'build', crateDir, '--target', 'nodejs', '--out-dir', 'pkg'],
      };
    case 'bun':
      return {
        command: 'bun',
        args: ['x', 'wasm-pack', 'build', crateDir, '--target', 'nodejs', '--out-dir', 'pkg'],
      };
    default:
      throw new Error(
        `Cannot determine wasm-pack invocation for unknown package manager. ` +
          `Expected one of pnpm-lock.yaml, package-lock.json, yarn.lock, bun.lockb/bun.lock.`,
      );
  }
}
