import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const port = Number(process.env.GOROMBO_HTTP_SMOKE_PORT || 3991);
const liveChat = process.argv.includes('--live-chat');

const envFileValues = parseEnvFile('.env');
const requestSecret = process.env.GOROMBO_HTTP_SMOKE_API_SECRET || envFileValues.API_SECRET || 'http-smoke-secret';
const nodeArgs = existsSync('.env') ? ['--env-file=.env', 'dist/server.mjs'] : ['dist/server.mjs'];

const child = spawn(process.execPath, nodeArgs, {
  cwd: process.cwd(),
  env: {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    PORT: String(port),
    API_SECRET: requestSecret,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stderr = '';
child.stderr.on('data', (chunk) => {
  stderr += chunk;
});

try {
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl);

  await expectStatus(`${baseUrl}/health`, { method: 'GET' }, 200, 'health');
  await expectStatus(
    `${baseUrl}/api/chat/events`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'auth check' }),
    },
    401,
    'chat event ingress without secret',
  );
  await expectStatus(
    `${baseUrl}/workflows/chat`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'auth check' }),
    },
    401,
    'direct chat workflow without secret',
  );
  await expectStatus(`${baseUrl}/runs/not-real`, { method: 'GET' }, 401, 'run inspection without secret');

  if (liveChat) {
    const runPointer = await expectJsonStatus(
      `${baseUrl}/api/chat/events`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-secret': requestSecret,
        },
        body: JSON.stringify({ text: 'Reply with exactly: endpoint-live-ok' }),
      },
      202,
      'chat event ingress with secret',
    );
    const run = await waitForRunResult(baseUrl, runPointer.runId, requestSecret);
    const serialized = JSON.stringify(run);
    if (!serialized.includes('endpoint-live-ok')) {
      throw new Error(`live chat run completed without expected text.\n${serialized.slice(0, 1000)}`);
    }
  }

  console.log(`HTTP endpoint smoke passed${liveChat ? ' with live chat' : ''}.`);
} finally {
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
}

function parseEnvFile(path) {
  const values = {};
  if (!existsSync(path)) {
    return values;
  }

  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separator = trimmed.indexOf('=');
    if (separator === -1) {
      continue;
    }

    values[trimmed.slice(0, separator)] = trimmed.slice(separator + 1).replace(/^['"]|['"]$/g, '');
  }

  return values;
}

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + 15_000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        return;
      }
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Server did not become healthy: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function expectStatus(url, init, expectedStatus, label) {
  const response = await fetch(url, init);
  await response.text();

  if (response.status !== expectedStatus) {
    throw new Error(`${label} returned ${response.status}, expected ${expectedStatus}.\n${stderr}`);
  }
}

async function expectJsonStatus(url, init, expectedStatus, label) {
  const response = await fetch(url, init);
  const text = await response.text();

  if (response.status !== expectedStatus) {
    throw new Error(`${label} returned ${response.status}, expected ${expectedStatus}.\n${stderr}`);
  }

  return JSON.parse(text);
}

async function waitForRunResult(baseUrl, runId, requestSecret) {
  if (!runId || typeof runId !== 'string') {
    throw new Error('Workflow response did not include a runId.');
  }

  const deadline = Date.now() + 120_000;
  let latest;

  while (Date.now() < deadline) {
    const run = await expectJsonStatus(
      `${baseUrl}/runs/${encodeURIComponent(runId)}`,
      {
        method: 'GET',
        headers: { 'x-api-secret': requestSecret },
      },
      200,
      'run inspection with secret',
    );
    latest = run;

    if (run.status === 'completed' || run.status === 'failed') {
      return run;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`Timed out waiting for workflow run result.\n${JSON.stringify(latest).slice(0, 1000)}`);
}
