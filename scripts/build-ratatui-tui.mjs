import { copyFileSync, chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const outDir = resolve('.gorombo', 'sim-one-ratatui');
const targetBinary = resolve('target', 'release', process.platform === 'win32' ? 'sim-one-ratatui-tui.exe' : 'sim-one-ratatui-tui');
const outBinary = resolve(outDir, process.platform === 'win32' ? 'sim-one-ratatui-tui.exe' : 'sim-one-ratatui-tui');

const result = spawnSync('cargo', ['build', '-p', 'sim-one-ratatui-tui', '--release'], {
  cwd: process.cwd(),
  stdio: 'inherit',
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

if (!existsSync(targetBinary)) {
  throw new Error(`Expected Ratatui binary was not built at ${targetBinary}`);
}

mkdirSync(dirname(outBinary), { recursive: true });
copyFileSync(targetBinary, outBinary);
chmodSync(outBinary, 0o755);

console.log(`[ratatui-build] Wrote ${outBinary}`);
