import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const simOneName = process.platform === 'win32' ? 'sim-one.cmd' : 'sim-one';
const simOnePath = join('.gorombo', 'sim-one-cli', simOneName);

if (!existsSync(simOnePath)) {
  throw new Error(`${simOnePath} does not exist. Run pnpm run build:cli first.`);
}

const result = await runCommand(simOnePath, ['--help']);
if (result.exitCode !== 0) {
  throw new Error(`sim-one --help failed with exit ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}
if (!result.stdout.includes('SIM-ONE Alpha') || !result.stdout.includes('skill')) {
  throw new Error(`sim-one --help did not look like the product CLI help.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

console.log(`[sim-one-product] ${simOnePath} is runnable.`);

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SIM_ONE_NODE: process.env.SIM_ONE_NODE || process.execPath,
      },
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });
}
