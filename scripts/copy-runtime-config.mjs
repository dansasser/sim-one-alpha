import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const source = resolve('src/config/gorombo.config.json');
const includeTscOutput = process.argv.includes('--tsc');
const targets = includeTscOutput
  ? [resolve('.tmp/tsc/config/gorombo.config.json')]
  : [resolve('dist/gorombo.config.json')];

if (!existsSync(source)) {
  throw new Error(`Runtime config source is missing: ${source}`);
}

for (const target of targets) {
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}
