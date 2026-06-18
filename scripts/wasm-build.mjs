#!/usr/bin/env node
/**
 * Build the gorombo-memory WASM artifact via `wasm-pack`.
 *
 * PM-agnostic at the API surface: detects the package manager from the
 * lockfile (mirroring src/workers/coding-worker/repo/package-manager.ts) and
 * invokes `wasm-pack` through it so downstream repos on npm/yarn/bun can also
 * build. Never uses corepack. When `wasm-pack` is installed globally on PATH
 * (as in CI), it is invoked directly.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const crateDir = resolve(process.cwd(), 'crates', 'gorombo-memory');
const outDir = 'pkg';
const target = 'nodejs';

function detectPackageManager(cwd) {
  if (existsSync(resolve(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(resolve(cwd, 'package-lock.json'))) return 'npm';
  if (existsSync(resolve(cwd, 'yarn.lock'))) return 'yarn';
  if (existsSync(resolve(cwd, 'bun.lockb')) || existsSync(resolve(cwd, 'bun.lock'))) return 'bun';
  return 'unknown';
}

function run(cmd, args, label) {
  console.log(`[wasm-build] ${label}: ${cmd} ${args.join(' ')}`);
  const result = spawnSync(cmd, args, { stdio: 'inherit', cwd: process.cwd() });
  if (result.error) {
    throw result.error;
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    throw new Error(`${label} exited with status ${result.status}`);
  }
}

function main() {
  if (!existsSync(crateDir)) {
    throw new Error(`gorombo-memory crate not found at ${crateDir}`);
  }

  // Prefer a globally-installed wasm-pack (CI installs it explicitly); fall
  // back to the detected package manager's executor.
  const pm = detectPackageManager(process.cwd());
  try {
    run('wasm-pack', ['build', crateDir, '--target', target, '--out-dir', outDir], 'wasm-pack');
  } catch (error) {
    if (pm === 'pnpm') run('pnpm', ['exec', 'wasm-pack', 'build', crateDir, '--target', target, '--out-dir', outDir], 'pnpm exec wasm-pack');
    else if (pm === 'npm') run('npx', ['wasm-pack', 'build', crateDir, '--target', target, '--out-dir', outDir], 'npx wasm-pack');
    else if (pm === 'yarn') run('yarn', ['wasm-pack', 'build', crateDir, '--target', target, '--out-dir', outDir], 'yarn wasm-pack');
    else if (pm === 'bun') run('bunx', ['wasm-pack', 'build', crateDir, '--target', target, '--out-dir', outDir], 'bunx wasm-pack');
    else throw error;
  }

  const artifact = resolve(crateDir, outDir, 'gorombo_memory_bg.wasm');
  if (!existsSync(artifact)) {
    throw new Error(`wasm-pack did not produce ${artifact}`);
  }
  console.log(`[wasm-build] artifact ready: ${artifact}`);
}

main();
