import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const pkgDir = resolve(repoRoot, 'crates', 'gorombo-memory', 'pkg');
const targetDir = resolve(repoRoot, 'dist', 'memory');

const requiredFiles = [
  'gorombo_memory.js',
  'gorombo_memory_bg.wasm',
  'gorombo_memory.d.ts',
];

if (!existsSync(pkgDir)) {
  throw new Error(`WASM package directory is missing: ${pkgDir}. Run \\"pnpm run wasm:build\\" first.`);
}

const missing = requiredFiles.filter((name) => !existsSync(join(pkgDir, name)));
if (missing.length > 0) {
  throw new Error(`WASM package is missing required files: ${missing.join(', ')}`);
}

mkdirSync(targetDir, { recursive: true });

for (const name of requiredFiles) {
  copyFileSync(join(pkgDir, name), join(targetDir, name));
}

// Copy any additional .wasm-related support files (e.g., package.json for pkg consumers)
for (const entry of readdirSync(pkgDir, { withFileTypes: true })) {
  if (entry.isDirectory()) {
    continue;
  }
  const source = join(pkgDir, entry.name);
  const target = join(targetDir, entry.name);
  if (!existsSync(target)) {
    copyFileSync(source, target);
  }
}

console.log(`WASM artifacts copied to ${targetDir}`);
