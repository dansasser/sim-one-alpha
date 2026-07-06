import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const outDir = resolve('.gorombo', 'sim-one-ratatui');
const cargoTargetDir = process.env.CARGO_TARGET_DIR
  ? resolve(process.env.CARGO_TARGET_DIR)
  : resolve('target');
const targetBinary = resolve(cargoTargetDir, 'release', process.platform === 'win32' ? 'sim-one-ratatui-tui.exe' : 'sim-one-ratatui-tui');
const outBinary = resolve(outDir, process.platform === 'win32' ? 'sim-one-ratatui-tui.exe' : 'sim-one-ratatui-tui');
const tmpBinary = `${outBinary}.tmp-${process.pid}`;

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
rmSync(tmpBinary, { force: true });
copyFileSync(targetBinary, tmpBinary);
chmodSync(tmpBinary, 0o755);
renameSync(tmpBinary, outBinary);

console.log(`[ratatui-build] Wrote ${outBinary}`);
