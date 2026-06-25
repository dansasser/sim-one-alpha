import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!existsSync('.gorombo/sim-one-alpha/server.mjs')) {
  throw new Error('.gorombo/sim-one-alpha/server.mjs does not exist. Run pnpm run build before the TUI e2e test.');
}

if (!existsSync('.gorombo/sim-one-cli/cli.js')) {
  throw new Error('.gorombo/sim-one-cli/cli.js does not exist. Run pnpm run build:cli before the TUI e2e test.');
}

const port = await getFreePort();
const baseUrl = `http://127.0.0.1:${port}`;
const envFileValues = parseEnvFile('.env');
const requestSecret = process.env.GOROMBO_HTTP_TEST_API_SECRET || envFileValues.API_SECRET || 'tui-e2e-test-secret';
const nodeArgs = existsSync('.env') ? ['--env-file=.env', '.gorombo/sim-one-alpha/server.mjs'] : ['.gorombo/sim-one-alpha/server.mjs'];
const codingWorkspaceRoot = mkdtempSync(join(tmpdir(), 'tui-e2e-coding-workspace-'));

// Use real Ollama Cloud key from env (CI passes it via secrets).
// Codex Brain gets a placeholder — validation passes, server boots, test uses the primary model.
const ollamaKey = process.env.OLLAMA_API_KEY || envFileValues.OLLAMA_API_KEY;
if (!ollamaKey) {
  throw new Error('OLLAMA_API_KEY is required for the TUI e2e test. Set it in env or .env.');
}

const modelEnv = {
  OLLAMA_API_KEY: ollamaKey,
  CODEX_BRAIN_LOCAL_API_KEY: process.env.CODEX_BRAIN_LOCAL_API_KEY || envFileValues.CODEX_BRAIN_LOCAL_API_KEY || 'tui-e2e-placeholder',
  CODEX_BRAIN_LOCAL_API_URL: process.env.CODEX_BRAIN_LOCAL_API_URL || envFileValues.CODEX_BRAIN_LOCAL_API_URL || 'https://dt1.example.test/v1',
};

const child = spawn(process.execPath, nodeArgs, {
  cwd: process.cwd(),
  env: {
    ...process.env,
    ...modelEnv,
    PORT: String(port),
    API_SECRET: requestSecret,
    GOROMBO_WORKSPACE_ROOT: codingWorkspaceRoot,
    GOROMBO_TEST_MODE: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stderr = '';
let stdout = '';
child.stderr.on('data', (chunk) => { stderr += String(chunk); });
child.stdout.on('data', (chunk) => { stdout += String(chunk); });

try {
  await waitForHealth();
  console.log('[tui-e2e] Server healthy, starting tests...');

  // Test 1: Direct agent prompt (simulates TUI sendMessage path via /agents/orchestrator)
  console.log('[tui-e2e] Test 1: Direct agent prompt via /agents/orchestrator...');
  const response1 = await fetch(
    `${baseUrl}/agents/orchestrator/tui-e2e-1?wait=result`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-secret': requestSecret,
      },
      body: JSON.stringify({ message: 'Hello, what can you do?' }),
    },
  );

  assertEqual(response1.status, 200, 'direct agent prompt should return 200');
  const result1 = await response1.json();
  const responseText = result1.text ?? result1.result?.text ?? result1.result;
  assertJson(
    typeof responseText === 'string' && responseText.length > 0,
    `direct agent prompt should return text. Got: ${JSON.stringify(result1).slice(0, 500)}`,
  );
  console.log('[tui-e2e] Test 1 PASSED: agent responded with text');

  // Test 2: Verify the response is not an error
  assertJson(
    !result1.isError && !result1.result?.isError,
    `agent response should not be an error. Got: ${JSON.stringify(result1).slice(0, 500)}`,
  );
  console.log('[tui-e2e] Test 2 PASSED: response is not an error');

  // Test 3: Verify CLI binary is runnable
  console.log('[tui-e2e] Test 3: Verifying CLI binary is runnable...');
  const cliResult = await runCliCommand(['--help']);
  assertEqual(cliResult.exitCode, 0, 'CLI --help should exit 0');
  assertJson(cliResult.stdout.length > 0, 'CLI --help should produce output');
  console.log('[tui-e2e] Test 3 PASSED: CLI binary is runnable');

  console.log('\n[tui-e2e] All TUI end-to-end tests passed.');
} finally {
  await stopChild(child);
  rmSync(codingWorkspaceRoot, { recursive: true, force: true });
}

// --- Helpers ---

function runCliCommand(args) {
  return new Promise((resolve, reject) => {
    const cliChild = spawn(process.execPath, ['.gorombo/sim-one-cli/cli.js', ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    });
    let cliStdout = '';
    let cliStderr = '';
    cliChild.stdout.on('data', (chunk) => { cliStdout += String(chunk); });
    cliChild.stderr.on('data', (chunk) => { cliStderr += String(chunk); });
    cliChild.on('error', reject);
    cliChild.on('close', (code) => resolve({ exitCode: code ?? 1, stdout: cliStdout, stderr: cliStderr }));
  });
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

async function waitForHealth() {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(`Server did not become healthy: ${lastError instanceof Error ? lastError.message : String(lastError)}\n${stderr}`);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message} (got ${actual}, expected ${expected})\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
}

function assertJson(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopChild(childProcess) {
  if (childProcess.exitCode !== null || childProcess.signalCode !== null) return;
  childProcess.kill('SIGTERM');
  if (await waitForChildExit(childProcess, 5_000)) return;
  childProcess.kill('SIGKILL');
  if (!(await waitForChildExit(childProcess, 5_000))) {
    throw new Error('Server child process did not exit after SIGKILL.');
  }
}

function waitForChildExit(childProcess, timeoutMs) {
  if (childProcess.exitCode !== null || childProcess.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => { childProcess.off('exit', onExit); resolve(false); }, timeoutMs);
    const onExit = () => { clearTimeout(timeout); resolve(true); };
    childProcess.once('exit', onExit);
  });
}