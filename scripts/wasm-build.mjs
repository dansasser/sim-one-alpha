#!/usr/bin/env node
/**
 * Build the gorombo-memory WASM artifact via `wasm-pack`.
 *
 * Invokes the `wasm-pack` CLI directly (installed via the Rust toolchain /
 * `rust-toolchain.toml` + CI, not as an npm package). The Rust toolchain and
 * wasm-pack are declared build prerequisites; `cargo test` / `wasm-pack` are
 * also exposed as package.json scripts (`cargo:test`, `wasm:build`).
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const crateDir = resolve(process.cwd(), 'crates', 'gorombo-memory');
const outDir = 'pkg';
const target = 'nodejs';

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
  const found = spawnSync('wasm-pack', ['--version'], { stdio: 'ignore' }).status === 0;
  if (!found) {
    throw new Error('wasm-pack not found on PATH. Install the Rust toolchain (rust-toolchain.toml) and `cargo install wasm-pack --version 0.13.1`, or add wasm-pack to PATH.');
  }
  run('wasm-pack', ['build', crateDir, '--target', target, '--out-dir', outDir], 'wasm-pack');
  const artifact = resolve(crateDir, outDir, 'gorombo_memory_bg.wasm');
  if (!existsSync(artifact)) {
    throw new Error(`wasm-pack did not produce ${artifact}`);
  }
  console.log(`[wasm-build] artifact ready: ${artifact}`);
}

main();
