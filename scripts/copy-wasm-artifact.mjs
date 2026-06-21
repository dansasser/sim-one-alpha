#!/usr/bin/env node
/**
 * Copy the gorombo-memory WASM artifact into the build output with a stable
 * relative path so the production runtime can load it. Mirrors the style of
 * scripts/copy-runtime-config.mjs.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';

const includeTscOutput = process.argv.includes('--tsc');
const sourceDir = resolve('crates', 'gorombo-memory', 'pkg');
const files = ['gorombo_memory_bg.wasm', 'gorombo_memory.js', 'gorombo_memory.d.ts'];
const targets = includeTscOutput
  ? [resolve('.tmp/tsc/memory')]
  : [resolve('dist/memory')];

if (!existsSync(sourceDir)) {
  throw new Error(`WASM artifact source missing: ${sourceDir}. Run \`pnpm run wasm:build\` first.`);
}

for (const target of targets) {
  mkdirSync(target, { recursive: true });
  for (const file of files) {
    const src = join(sourceDir, file);
    if (!existsSync(src)) {
      throw new Error(`Required WASM artifact missing: ${src}. Build incomplete.`);
    }
    const dest = join(target, file);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    console.log(`[copy-wasm-artifact] ${src} -> ${dest}`);
  }
}
