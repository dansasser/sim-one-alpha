#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

function parseEnvFile(envPath) {
  if (!existsSync(envPath)) return {};
  const env = {};
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim().replace(/^["']|["']$/g, '');
    if (key) env[key] = value;
  }
  return env;
}

const envPath = resolve(repoRoot, '.env');
const envVars = parseEnvFile(envPath);
const apiKey = envVars.API_SECRET || process.env.API_SECRET;
const port = process.env.PORT || envVars.PORT || '3000';

if (!apiKey) {
  console.error('API_SECRET required: set it in .env or pass as environment variable.');
  process.exit(1);
}

console.log('Building runtime...');
const buildResult = spawnSync('pnpm', ['run', 'build'], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: { ...process.env, ...envVars },
});
if (buildResult.status !== 0) {
  console.error('Build failed.');
  process.exit(buildResult.status ?? 1);
}

console.log(`Starting server on port ${port}...`);
const serverEnv = { ...process.env, ...envVars, PORT: port };
const server = spawn('node', ['--env-file=.env', 'dist/server.mjs'], {
  cwd: repoRoot,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: serverEnv,
  detached: false,
});

server.stdout?.on('data', (data) => {
  const text = data.toString().trim();
  if (text) console.log(`[server] ${text}`);
});
server.stderr?.on('data', (data) => {
  const text = data.toString().trim();
  if (text) console.error(`[server] ${text}`);
});

let serverReady = false;
const readinessCheck = setInterval(() => {
  fetch(`http://127.0.0.1:${port}/health`)
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (data?.ok) {
        serverReady = true;
        clearInterval(readinessCheck);
        console.log('Server ready. Launching TUI...');
        launchTui();
      }
    })
    .catch(() => {
      // server not ready yet, keep polling
    });
}, 2000);

const startTime = Date.now();
const readinessTimeout = setTimeout(() => {
  if (!serverReady) {
    clearInterval(readinessCheck);
    console.error('Server did not become ready within 120 seconds.');
    cleanup(1);
  }
}, 120000);

function launchTui() {
  clearTimeout(readinessTimeout);
  const baseUrl = `http://127.0.0.1:${port}`;
  const tui = spawn(
    'pnpm',
    ['--filter', 'sim-one-alpha-tui-proto', 'exec', 'tsx', 'src/cli.tsx', '--base-url', baseUrl, '--token', apiKey],
    {
      cwd: repoRoot,
      stdio: 'inherit',
      env: { ...process.env, ...envVars },
    },
  );

  tui.on('exit', (code) => {
    console.log(`TUI exited with code ${code}.`);
    cleanup(code ?? 0);
  });

  tui.on('error', (err) => {
    console.error('TUI failed to start:', err.message);
    cleanup(1);
  });
}

function cleanup(exitCode) {
  clearInterval(readinessCheck);
  clearTimeout(readinessTimeout);
  if (server.pid && !server.killed) {
    console.log('Shutting down server...');
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      server.kill('SIGTERM');
    }
  }
  process.exit(exitCode);
}

process.on('SIGINT', () => cleanup(0));
process.on('SIGTERM', () => cleanup(0));