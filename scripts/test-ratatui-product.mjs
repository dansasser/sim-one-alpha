import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const serverDir = '.gorombo/sim-one-alpha';
const serverPath = join(serverDir, 'server.mjs');
const tuiPath = '.gorombo/sim-one-ratatui/sim-one-ratatui-tui';

if (!existsSync(serverPath)) {
  throw new Error(`${serverPath} does not exist. Run pnpm run build before the Ratatui product smoke test.`);
}

if (!existsSync(tuiPath)) {
  throw new Error(`${tuiPath} does not exist. Run pnpm run build:tui:ratatui before the Ratatui product smoke test.`);
}

const port = await getFreePort();
const envFileValues = parseEnvFile('.env');
const codingWorkspaceRoot = mkdtempSync(join(tmpdir(), 'ratatui-product-workspace-'));
const configPath = join(serverDir, 'gorombo.config.json');
const originalConfig = readFileSync(configPath, 'utf8');
const config = JSON.parse(originalConfig);
config.gateway = { ...(config.gateway ?? {}), port };
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

const child = spawn('./.gorombo/sim-one-ratatui/sim-one-ratatui-tui', [], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PATH: productLikePath(),
    NVM_DIR: process.env.NVM_DIR || '/root/.nvm',
    OLLAMA_API_KEY: process.env.OLLAMA_API_KEY || envFileValues.OLLAMA_API_KEY || 'ratatui-product-placeholder',
    CODEX_BRAIN_LOCAL_API_KEY: process.env.CODEX_BRAIN_LOCAL_API_KEY || envFileValues.CODEX_BRAIN_LOCAL_API_KEY || 'ratatui-product-placeholder',
    CODEX_BRAIN_LOCAL_API_URL: process.env.CODEX_BRAIN_LOCAL_API_URL || envFileValues.CODEX_BRAIN_LOCAL_API_URL || 'https://dt1.example.test/v1',
    GOROMBO_WORKSPACE_ROOT: codingWorkspaceRoot,
    GOROMBO_TEST_MODE: '1',
    SIM_ONE_TUI_EXIT_AFTER_STARTUP: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => { stdout += String(chunk); });
child.stderr.on('data', (chunk) => { stderr += String(chunk); });

try {
  const exitCode = await waitForExit(child, 130_000);
  if (exitCode !== 0) {
    throw new Error(`Ratatui product smoke failed with exit ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  if (!stdout.includes(`gateway ready at http://127.0.0.1:${port}`)) {
    throw new Error(`Ratatui product smoke did not report gateway readiness.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  if (!stdout.includes('started: true')) {
    throw new Error(`Ratatui product smoke reused a server instead of starting one.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  console.log('[ratatui-product] Built TUI command started gateway and exited cleanly.');
} finally {
  writeFileSync(configPath, originalConfig);
  rmSync(codingWorkspaceRoot, { recursive: true, force: true });
}

function parseEnvFile(path) {
  const values = {};
  if (!existsSync(path)) return values;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    values[trimmed.slice(0, separator)] = trimmed.slice(separator + 1).replace(/^['"]|['"]$/g, '');
  }
  return values;
}

function productLikePath() {
  const defaultNodeBin = '/root/.nvm/versions/node/v20.20.0/bin';
  const currentPath = process.env.PATH || '';
  const withoutActiveNode22 = currentPath
    .split(delimiter)
    .filter((entry) => !entry.includes('/versions/node/v22'))
    .join(delimiter);

  if (existsSync(join(defaultNodeBin, 'node'))) {
    return [defaultNodeBin, withoutActiveNode22].filter(Boolean).join(delimiter);
  }

  return withoutActiveNode22 || currentPath;
}

async function getFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(() => resolve()));
  if (!address || typeof address === 'string') throw new Error('Could not allocate a local HTTP test port.');
  return address.port;
}

function waitForExit(childProcess, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      childProcess.kill('SIGKILL');
      reject(new Error(`Ratatui product smoke timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    childProcess.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    childProcess.once('exit', (code) => {
      clearTimeout(timeout);
      resolve(code ?? 1);
    });
  });
}
