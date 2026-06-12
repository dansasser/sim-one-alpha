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
    `${baseUrl}/workflows/not-real`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'auth check' }),
    },
    401,
    'workflow route without secret',
  );
  await expectStatus(`${baseUrl}/runs/not-real`, { method: 'GET' }, 401, 'run inspection without secret');

  if (liveChat) {
    const agentResult = await expectJsonStatus(
      `${baseUrl}/api/chat/events`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-secret': requestSecret,
        },
        body: JSON.stringify({
          text: 'Reply with exactly: endpoint-live-ok',
          actorId: 'http-smoke-user',
          conversationId: 'http-smoke-thread',
        }),
      },
      200,
      'chat event ingress with secret',
    );
    if (!agentResultContainsText(agentResult, 'endpoint-live-ok')) {
      const serialized = JSON.stringify(agentResult);
      throw new Error(`live chat agent response completed without expected text.\n${serialized.slice(0, 1000)}`);
    }
  }

  console.log(`HTTP endpoint smoke passed${liveChat ? ' with live chat' : ''}.`);
} finally {
  await stopChild(child);
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

function agentResultContainsText(agentResult, expectedText) {
  for (const candidate of readAgentResultTextCandidates(agentResult)) {
    if (candidate.includes(expectedText)) {
      return true;
    }
  }

  return false;
}

function readAgentResultTextCandidates(agentResult) {
  if (!agentResult || typeof agentResult !== 'object') {
    return [];
  }

  const candidates = [
    agentResult.result?.text,
    agentResult.output,
    agentResult.response,
    agentResult.text,
  ];

  if (Array.isArray(agentResult.choices)) {
    for (const choice of agentResult.choices) {
      candidates.push(choice?.message?.content, choice?.text, choice?.delta?.content);
    }
  }

  return candidates.filter((candidate) => typeof candidate === 'string');
}

async function stopChild(childProcess) {
  if (childProcess.exitCode !== null || childProcess.signalCode !== null) {
    return;
  }

  childProcess.kill('SIGTERM');
  if (await waitForChildExit(childProcess, 3_000)) {
    return;
  }

  childProcess.kill('SIGKILL');
  if (!(await waitForChildExit(childProcess, 5_000))) {
    throw new Error('HTTP smoke child process did not exit after SIGKILL.');
  }
}

function waitForChildExit(childProcess, timeoutMs) {
  if (childProcess.exitCode !== null || childProcess.signalCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      childProcess.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    childProcess.once('exit', onExit);
  });
}
