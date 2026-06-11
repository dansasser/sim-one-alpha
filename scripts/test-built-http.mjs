import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';

if (!existsSync('dist/server.mjs')) {
  throw new Error('dist/server.mjs does not exist. Run npm run build before the built HTTP test.');
}

const port = await getFreePort();
const baseUrl = `http://127.0.0.1:${port}`;
const envFileValues = parseEnvFile('.env');
const requestSecret = process.env.GOROMBO_HTTP_TEST_API_SECRET || envFileValues.API_SECRET || 'built-http-test-secret';
const nodeArgs = existsSync('.env') ? ['--env-file=.env', 'dist/server.mjs'] : ['dist/server.mjs'];

const child = spawn(process.execPath, nodeArgs, {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    API_SECRET: requestSecret,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stderr = '';
let stdout = '';
child.stderr.on('data', (chunk) => {
  stderr += String(chunk);
});
child.stdout.on('data', (chunk) => {
  stdout += String(chunk);
});

try {
  await waitForHealth();

  await expectJsonStatus(`${baseUrl}/health`, { method: 'GET' }, 200, 'health', (body) => {
    assertJson(body && body.ok === true, 'health did not return { ok: true }');
  });

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
    `${baseUrl}/api/chat/events`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-secret': requestSecret,
      },
      body: '{not valid json',
    },
    400,
    'chat event ingress invalid JSON with secret',
  );

  await expectStatus(`${baseUrl}/api/chat/sessions`, { method: 'GET' }, 401, 'chat sessions without secret');

  await expectJsonStatus(
    `${baseUrl}/api/chat/sessions?limit=3`,
    {
      method: 'GET',
      headers: { 'x-api-secret': requestSecret },
    },
    200,
    'chat sessions with secret',
    (body) => {
      assertJson(Array.isArray(body.sessions), 'chat sessions response did not include a sessions array');
    },
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

  const webNewRunPointer = await expectJsonStatus(
    `${baseUrl}/api/chat/events`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-secret': requestSecret,
      },
      body: JSON.stringify({
        text: '/new',
        actorId: 'built-http-web-user',
        conversationId: `built-http-web-${Date.now().toString(36)}`,
      }),
    },
    202,
    'chat event web /new workflow with secret',
    (body) => {
      assertJson(typeof body.runId === 'string' && body.runId.length > 0, 'web /new workflow did not return a runId');
    },
  );
  const webNewRun = await waitForRunEnd(webNewRunPointer.runId);
  const webNewRunText = JSON.stringify(webNewRun);
  assertJson(
    webNewRunText.includes('/new is handled by the web client session controls') &&
      webNewRunText.includes('"name":"new"'),
    `web /new workflow run did not include the expected command result.\n${webNewRunText.slice(0, 1200)}`,
  );

  const tuiNewRunPointer = await expectJsonStatus(
    `${baseUrl}/api/chat/events`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-secret': requestSecret,
      },
      body: JSON.stringify({
        text: '/new built http notes',
        connector: 'tui',
        actorId: 'built-http-tui-user',
        conversationId: `built-http-tui-${Date.now().toString(36)}`,
      }),
    },
    202,
    'chat event tui /new workflow with secret',
    (body) => {
      assertJson(typeof body.runId === 'string' && body.runId.length > 0, 'tui /new workflow did not return a runId');
    },
  );
  const tuiNewRun = await waitForRunEnd(tuiNewRunPointer.runId);
  const tuiNewRunText = JSON.stringify(tuiNewRun);
  assertJson(
    tuiNewRunText.includes('Started new session tui-') && tuiNewRunText.includes('"name":"new"'),
    `tui /new workflow run did not include the expected command result.\n${tuiNewRunText.slice(0, 1200)}`,
  );
  const tuiSessionId = tuiNewRunText.match(/Started new session (tui-[A-Za-z0-9-]+)/)?.[1];
  assertJson(typeof tuiSessionId === 'string', `Could not extract TUI session id from /new run.\n${tuiNewRunText.slice(0, 1200)}`);

  const deniedResumeRunPointer = await expectJsonStatus(
    `${baseUrl}/api/chat/events`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-secret': requestSecret,
      },
      body: JSON.stringify({
        text: 'try to resume another user session',
        connector: 'tui',
        actorId: 'built-http-tui-other-user',
        conversationId: `built-http-tui-other-${Date.now().toString(36)}`,
        session: tuiSessionId,
      }),
    },
    202,
    'chat event denied explicit session resume workflow with secret',
    (body) => {
      assertJson(typeof body.runId === 'string' && body.runId.length > 0, 'denied resume workflow did not return a runId');
    },
  );
  const deniedResumeRun = await waitForRunEnd(deniedResumeRunPointer.runId);
  const deniedResumeRunText = JSON.stringify(deniedResumeRun);
  assertJson(
    deniedResumeRunText.includes(`Session ${tuiSessionId} is not available for this actor or conversation.`),
    `denied explicit session resume did not include the expected refusal.\n${deniedResumeRunText.slice(0, 1200)}`,
  );

  const spoofedConnectorNewRunPointer = await expectJsonStatus(
    `${baseUrl}/api/chat/events`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-secret': requestSecret,
      },
      body: JSON.stringify({
        text: '/new telegram notes',
        connector: 'telegram',
        actorId: 'built-http-telegram-user',
        conversationId: `built-http-telegram-${Date.now().toString(36)}`,
      }),
    },
    202,
    'chat event spoofed connector /new workflow with secret',
    (body) => {
      assertJson(typeof body.runId === 'string' && body.runId.length > 0, 'spoofed connector /new workflow did not return a runId');
    },
  );
  const spoofedConnectorNewRun = await waitForRunEnd(spoofedConnectorNewRunPointer.runId);
  const spoofedConnectorNewRunText = JSON.stringify(spoofedConnectorNewRun);
  assertJson(
    spoofedConnectorNewRunText.includes('/new is handled by the web client session controls') &&
      spoofedConnectorNewRunText.includes('"name":"new"'),
    `spoofed connector /new workflow run did not include the expected web-safe command result.\n${spoofedConnectorNewRunText.slice(0, 1200)}`,
  );

  const compactRunPointer = await expectJsonStatus(
    `${baseUrl}/api/chat/events`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-secret': requestSecret,
      },
      body: JSON.stringify({
        text: '/compact',
        connector: 'tui',
        actorId: 'built-http-user',
        conversationId: `built-http-session-${Date.now().toString(36)}`,
      }),
    },
    202,
    'chat event compact workflow with secret',
    (body) => {
      assertJson(typeof body.runId === 'string' && body.runId.length > 0, 'compact workflow did not return a runId');
    },
  );
  const compactRun = await waitForRunEnd(compactRunPointer.runId);
  const compactRunText = JSON.stringify(compactRun);
  assertJson(
    compactRunText.includes('Compacted session') && compactRunText.includes('"name":"compact"'),
    `compact workflow run did not include the expected command result.\n${compactRunText.slice(0, 1200)}`,
  );

  const missingRunId = 'workflow:chat:built-http-missing-run';
  await expectStatus(`${baseUrl}/runs/${encodeURIComponent(missingRunId)}`, { method: 'GET' }, 401, 'run lookup without secret');
  await expectStatus(
    `${baseUrl}/runs/${encodeURIComponent(missingRunId)}`,
    {
      method: 'GET',
      headers: { 'x-api-secret': requestSecret },
    },
    404,
    'missing run lookup with secret',
  );

  await expectStatus(
    `${baseUrl}/api/telemetry/runs/${encodeURIComponent(missingRunId)}`,
    {
      method: 'GET',
      headers: { 'x-api-secret': requestSecret },
    },
    404,
    'missing telemetry run with secret',
  );

  await expectJsonStatus(
    `${baseUrl}/api/telemetry/runs`,
    {
      method: 'GET',
      headers: { 'x-api-secret': requestSecret },
    },
    200,
    'telemetry run list with secret',
    (body) => {
      assertJson(Array.isArray(body.runs), 'telemetry snapshot did not include a runs array');
      assertJson(typeof body.unscopedEventCount === 'number', 'telemetry snapshot did not include unscopedEventCount');
    },
  );

  console.log('Built HTTP integration test passed.');
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

async function getFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  if (!address || typeof address === 'string') {
    throw new Error('Could not allocate a local HTTP test port.');
  }

  return address.port;
}

async function waitForHealth() {
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

    await delay(250);
  }

  throw new Error(`Built server did not become healthy: ${lastError instanceof Error ? lastError.message : String(lastError)}\n${stderr}`);
}

async function expectStatus(url, init, expectedStatus, label) {
  const response = await fetch(url, init);
  await response.text();

  if (response.status !== expectedStatus) {
    throw new Error(`${label} returned ${response.status}, expected ${expectedStatus}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
}

async function expectJsonStatus(url, init, expectedStatus, label, validate) {
  const response = await fetch(url, init);
  const text = await response.text();

  if (response.status !== expectedStatus) {
    throw new Error(`${label} returned ${response.status}, expected ${expectedStatus}.\nbody:\n${text}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} did not return JSON: ${error instanceof Error ? error.message : String(error)}.\nbody:\n${text}`);
  }

  validate(body);
  return body;
}

function assertJson(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRunEnd(runId) {
  const deadline = Date.now() + 60_000;
  let latest;

  while (Date.now() < deadline) {
    latest = await expectJsonStatus(
      `${baseUrl}/runs/${encodeURIComponent(runId)}`,
      {
        method: 'GET',
        headers: { 'x-api-secret': requestSecret },
      },
      200,
      'workflow run lookup',
      (body) => {
        assertJson(isRunLookupBody(body), 'workflow run lookup did not return an event stream array or run status object');
      },
    );

    if (readRunCompletion(latest)) {
      return latest;
    }

    await delay(500);
  }

  throw new Error(`Timed out waiting for workflow run_end.\n${JSON.stringify(latest).slice(0, 1200)}`);
}

function isRunLookupBody(body) {
  return Array.isArray(body) || (body && typeof body === 'object' && typeof body.status === 'string');
}

function readRunCompletion(run) {
  if (Array.isArray(run)) {
    return run.find((event) => event && event.type === 'run_end');
  }

  if (run && (run.status === 'completed' || run.status === 'failed')) {
    return run;
  }

  return undefined;
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
    throw new Error('Built HTTP child process did not exit after SIGKILL.');
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
