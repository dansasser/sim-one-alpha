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
import { delimiter, dirname, join } from 'node:path';

const serverDir = '.gorombo/sim-one-alpha';
const serverPath = join(serverDir, 'server.mjs');
const tuiBinaryName = process.platform === 'win32' ? 'sim-one-ratatui-tui.exe' : 'sim-one-ratatui-tui';
const tuiPath = join('.gorombo', 'sim-one-ratatui', tuiBinaryName);

if (!existsSync(serverPath)) {
  throw new Error(`${serverPath} does not exist. Run pnpm run build before the Ratatui product smoke test.`);
}

if (!existsSync(tuiPath)) {
  throw new Error(`${tuiPath} does not exist. Run pnpm run build:tui:ratatui before the Ratatui product smoke test.`);
}

const port = await getFreePort();
const envFileValues = parseEnvFile('.env');
const ollamaKey =
  process.env.OLLAMA_API_KEY ||
  process.env.OLLAMA_CLOUD_API_KEY ||
  envFileValues.OLLAMA_API_KEY ||
  envFileValues.OLLAMA_CLOUD_API_KEY;
if (!ollamaKey) {
  throw new Error('OLLAMA_API_KEY or OLLAMA_CLOUD_API_KEY is required for the Ratatui product prompt test. Set it in env or .env.');
}
const codingWorkspaceRoot = mkdtempSync(join(tmpdir(), 'ratatui-product-workspace-'));
const configPath = join(serverDir, 'gorombo.config.json');
const originalConfig = readFileSync(configPath, 'utf8');

let stdout = '';
let stderr = '';
let child;

try {
  const config = JSON.parse(originalConfig);
  config.gateway = { ...(config.gateway ?? {}), port };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const childEnv = {
    ...process.env,
    PATH: productLikePath(),
    SIM_ONE_NODE: process.env.SIM_ONE_NODE || process.execPath,
    OLLAMA_API_KEY: process.env.OLLAMA_API_KEY || envFileValues.OLLAMA_API_KEY || ollamaKey,
    OLLAMA_CLOUD_API_KEY: process.env.OLLAMA_CLOUD_API_KEY || envFileValues.OLLAMA_CLOUD_API_KEY || ollamaKey,
    CODEX_BRAIN_LOCAL_API_KEY: process.env.CODEX_BRAIN_LOCAL_API_KEY || envFileValues.CODEX_BRAIN_LOCAL_API_KEY || 'ratatui-product-placeholder',
    CODEX_BRAIN_LOCAL_API_URL: process.env.CODEX_BRAIN_LOCAL_API_URL || envFileValues.CODEX_BRAIN_LOCAL_API_URL || 'https://dt1.example.test/v1',
    GOROMBO_WORKSPACE_ROOT: codingWorkspaceRoot,
    GOROMBO_TEST_MODE: '1',
    SIM_ONE_TUI_TEST_PROMPT: 'Reply with one short sentence confirming the Ratatui product prompt path works.',
  };
  if (!childEnv.NVM_DIR && process.env.HOME) {
    childEnv.NVM_DIR = join(process.env.HOME, '.nvm');
  }

  child = spawn(tuiPath, [], {
    cwd: process.cwd(),
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });

  const exitCode = await waitForClose(child, 240_000);
  if (exitCode !== 0) {
    throw new Error(`Ratatui product smoke failed with exit ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  const responseMarker = 'assistant response:';
  if (!stdout.includes(responseMarker)) {
    throw new Error(`Ratatui product smoke did not report an agent response.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  const responseText = stdout.slice(stdout.indexOf(responseMarker) + responseMarker.length).trim();
  if (responseText.length < 8 || /placeholder/i.test(responseText)) {
    throw new Error(`Ratatui product smoke response was not a real agent response.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  console.log('[ratatui-product] Built TUI command sent a real prompt and received an agent response.');
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
  }
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
  const currentPath = process.env.PATH || '';
  const nodeBin = dirname(process.env.SIM_ONE_NODE || process.execPath);
  return [nodeBin, currentPath].filter(Boolean).join(delimiter);
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

function waitForClose(childProcess, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      childProcess.kill('SIGKILL');
      reject(new Error(`Ratatui product smoke timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    let spawnError;
    childProcess.once('error', (error) => {
      spawnError = error;
    });
    childProcess.once('close', (code) => {
      clearTimeout(timeout);
      if (spawnError) {
        reject(spawnError);
      } else {
        resolve(code ?? 1);
      }
    });
  });
}
