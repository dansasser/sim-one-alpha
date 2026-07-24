import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { acquireProductArtifactLock } from './product-artifact-lock.mjs';

if (!existsSync('.gorombo/sim-one-alpha/server.mjs')) {
  throw new Error('.gorombo/sim-one-alpha/server.mjs does not exist. Run pnpm run build before the built HTTP test.');
}

const port = await getFreePort();
const baseUrl = `http://127.0.0.1:${port}`;
const envFileValues = parseEnvFile('.env');
const requestSecret = process.env.GOROMBO_HTTP_TEST_API_SECRET || envFileValues.API_SECRET || 'built-http-test-secret';
const nodeArgs = existsSync('.env') ? ['--env-file=.env', '.gorombo/sim-one-alpha/server.mjs'] : ['.gorombo/sim-one-alpha/server.mjs'];
const codingWorkspaceRoot = mkdtempSync(join(tmpdir(), 'built-http-coding-workspace-'));
const configPath = '.gorombo/sim-one-alpha/gorombo.config.json';
const releaseArtifactLock = await acquireProductArtifactLock();
let originalConfig;
const sessionDatabasePath = join(codingWorkspaceRoot, 'sessions.sqlite');
const modelEnv = {
  OLLAMA_API_KEY: process.env.OLLAMA_API_KEY || envFileValues.OLLAMA_API_KEY || 'built-http-test-key',
  CODEX_BRAIN_LOCAL_API_KEY:
    process.env.CODEX_BRAIN_LOCAL_API_KEY || envFileValues.CODEX_BRAIN_LOCAL_API_KEY || 'built-http-test-key',
  CODEX_BRAIN_LOCAL_API_URL:
    process.env.CODEX_BRAIN_LOCAL_API_URL || envFileValues.CODEX_BRAIN_LOCAL_API_URL || 'https://dt1.example.test/v1',
};

let stderr = '';
let stdout = '';
let child;

try {
  originalConfig = readFileSync(configPath, 'utf8');
  const config = JSON.parse(originalConfig);
  config.storage = {
    ...(config.storage ?? {}),
    flueDatabasePath: join(codingWorkspaceRoot, 'flue.sqlite'),
    sessionDatabasePath,
    vectorStorePath: join(codingWorkspaceRoot, 'vectors'),
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  child = spawn(process.execPath, nodeArgs, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...modelEnv,
      PORT: String(port),
      API_SECRET: requestSecret,
      GOROMBO_WORKSPACE_ROOT: codingWorkspaceRoot,
      GOROMBO_TEST_MODE: '1',
      TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || envFileValues.TELEGRAM_BOT_TOKEN || 'built-http-test-bot-token',
      TELEGRAM_WEBHOOK_SECRET_TOKEN: process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN || envFileValues.TELEGRAM_WEBHOOK_SECRET_TOKEN || 'built-http-test-webhook-secret',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });

  await waitForHealth();

  const externalHeaders = { 'x-forwarded-for': '10.0.0.1' };

  await expectJsonStatus(`${baseUrl}/health`, { method: 'GET' }, 200, 'health', (body) => {
    assertJson(body && body.ok === true, 'health did not return { ok: true }');
  });

  await expectStatus(
    `${baseUrl}/api/chat/events`,
    {
      method: 'POST',
      headers: { ...externalHeaders, 'content-type': 'application/json' },
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
        ...externalHeaders,
        'content-type': 'application/json',
        'x-api-secret': requestSecret,
      },
      body: '{not valid json',
    },
    400,
    'chat event ingress invalid JSON with secret',
  );

  await expectStatus(`${baseUrl}/api/chat/sessions`, { method: 'GET', headers: externalHeaders }, 401, 'chat sessions without secret');

  const lifecycleIdentity = {
    connector: 'tui',
    actorId: 'built-http-lifecycle-user',
    conversationId: `built-http-lifecycle-${Date.now().toString(36)}`,
    threadId: 'local-tui',
  };
  const firstLifecycle = await expectJsonStatus(
    `${baseUrl}/api/chat/sessions`,
    {
      method: 'POST',
      headers: {
        ...externalHeaders,
        'content-type': 'application/json',
        'x-api-secret': requestSecret,
      },
      body: JSON.stringify(lifecycleIdentity),
    },
    201,
    'first fresh TUI lifecycle session',
    (body) => {
      assertJson(body.session?.created === true, `first lifecycle call did not create a session.\n${JSON.stringify(body)}`);
    },
  );
  const secondLifecycle = await expectJsonStatus(
    `${baseUrl}/api/chat/sessions`,
    {
      method: 'POST',
      headers: {
        ...externalHeaders,
        'content-type': 'application/json',
        'x-api-secret': requestSecret,
      },
      body: JSON.stringify(lifecycleIdentity),
    },
    201,
    'second fresh TUI lifecycle session',
    (body) => {
      assertJson(body.session?.created === true, `second lifecycle call did not create a session.\n${JSON.stringify(body)}`);
    },
  );
  const firstLifecycleId = firstLifecycle.session?.id;
  const secondLifecycleId = secondLifecycle.session?.id;
  assertJson(typeof firstLifecycleId === 'string', 'first lifecycle response did not include a session id');
  assertJson(typeof secondLifecycleId === 'string', 'second lifecycle response did not include a session id');
  assertJson(firstLifecycleId !== secondLifecycleId, `fresh lifecycle calls reused session ${firstLifecycleId}`);
  assertJson(
    countNormalizedEventsForActors(sessionDatabasePath, [lifecycleIdentity.actorId]) === 0,
    'session lifecycle calls created normalized chat-message events',
  );

  await expectJsonStatus(
    `${baseUrl}/api/chat/sessions/${encodeURIComponent(firstLifecycleId)}/resume`,
    {
      method: 'POST',
      headers: {
        ...externalHeaders,
        'content-type': 'application/json',
        'x-api-secret': requestSecret,
      },
      body: JSON.stringify(lifecycleIdentity),
    },
    200,
    'owned TUI lifecycle resume',
    (body) => {
      assertJson(
        body.session?.id === firstLifecycleId && body.session?.created === false,
        `owned resume did not return exact session metadata.\n${JSON.stringify(body)}`,
      );
    },
  );

  await expectStatus(
    `${baseUrl}/api/chat/sessions/${encodeURIComponent(firstLifecycleId)}/resume`,
    {
      method: 'POST',
      headers: {
        ...externalHeaders,
        'content-type': 'application/json',
        'x-api-secret': requestSecret,
      },
      body: JSON.stringify({ ...lifecycleIdentity, actorId: 'built-http-lifecycle-other-user' }),
    },
    403,
    'cross-actor TUI lifecycle resume',
  );

  const lifecycleQuery = new URLSearchParams({
    ...lifecycleIdentity,
    limit: '10',
  });
  await expectJsonStatus(
    `${baseUrl}/api/chat/sessions?${lifecycleQuery}`,
    {
      method: 'GET',
      headers: { ...externalHeaders, 'x-api-secret': requestSecret },
    },
    200,
    'scope-filtered TUI lifecycle list',
    (body) => {
      const ids = new Set(body.sessions?.map((session) => session.sessionId));
      assertJson(
        ids.has(firstLifecycleId) && ids.has(secondLifecycleId) && ids.size === 2,
        `scoped lifecycle list did not contain exactly both owned sessions.\n${JSON.stringify(body)}`,
      );
    },
  );

  const otherLifecycleQuery = new URLSearchParams({
    ...lifecycleIdentity,
    actorId: 'built-http-lifecycle-other-user',
    limit: '10',
  });
  await expectJsonStatus(
    `${baseUrl}/api/chat/sessions?${otherLifecycleQuery}`,
    {
      method: 'GET',
      headers: { ...externalHeaders, 'x-api-secret': requestSecret },
    },
    200,
    'other-actor TUI lifecycle list',
    (body) => {
      assertJson(Array.isArray(body.sessions) && body.sessions.length === 0, 'other actor could list owned TUI sessions');
    },
  );

  await expectStatus(
    `${baseUrl}/workflows/not-real`,
    {
      method: 'POST',
      headers: { ...externalHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'auth check' }),
    },
    401,
    'workflow route without secret',
  );

  const webNewCommand = await expectJsonStatus(
    `${baseUrl}/api/chat/events`,
    {
      method: 'POST',
      headers: {
        ...externalHeaders,
        'content-type': 'application/json',
        'x-api-secret': requestSecret,
      },
      body: JSON.stringify({
        text: '/new',
        actorId: 'built-http-web-user',
        conversationId: `built-http-web-${Date.now().toString(36)}`,
      }),
    },
    200,
    'chat event web /new command with secret',
    (body) => {
      assertJson(
        body.result?.text?.includes('/new is handled by the web client session controls') &&
          body.result?.command?.name === 'new',
        `web /new command did not include the expected command result.\n${JSON.stringify(body).slice(0, 1200)}`,
      );
    },
  );
  assertJson(
    webNewCommand.event?.id,
    `web /new command did not include an event id.\n${JSON.stringify(webNewCommand).slice(0, 1200)}`,
  );

  const tuiActorId = 'built-http-tui-user';
  const tuiConversationId = `built-http-tui-${Date.now().toString(36)}`;
  const tuiNewCommand = await expectJsonStatus(
    `${baseUrl}/api/chat/events`,
    {
      method: 'POST',
      headers: {
        ...externalHeaders,
        'content-type': 'application/json',
        'x-api-secret': requestSecret,
      },
      body: JSON.stringify({
        text: '/new built http notes',
        connector: 'tui',
        actorId: tuiActorId,
        conversationId: tuiConversationId,
      }),
    },
    200,
    'chat event tui /new command with secret',
    (body) => {
      assertJson(
        body.result?.text?.includes('Started new session tui-') &&
          body.result?.command?.name === 'new' &&
          typeof body.session?.id === 'string',
        `tui /new command did not include the expected command result.\n${JSON.stringify(body).slice(0, 1200)}`,
      );
    },
  );
  const tuiSessionId = tuiNewCommand.session?.id;
  assertJson(typeof tuiSessionId === 'string', `Could not extract TUI session id from /new command.\n${JSON.stringify(tuiNewCommand).slice(0, 1200)}`);

  await expectJsonStatus(
    `${baseUrl}/api/chat/events`,
    {
      method: 'POST',
      headers: {
        ...externalHeaders,
        'content-type': 'application/json',
        'x-api-secret': requestSecret,
      },
      body: JSON.stringify({
        text: `/resume ${tuiSessionId}`,
        connector: 'tui',
        actorId: tuiActorId,
        conversationId: tuiConversationId,
      }),
    },
    200,
    'chat event tui /resume command with secret',
    (body) => {
      assertJson(
        body.result?.text === `Resumed session ${tuiSessionId}.` &&
          body.result?.command?.name === 'resume' &&
          body.session?.id === tuiSessionId,
        `tui /resume command did not include the expected command result.\n${JSON.stringify(body).slice(0, 1200)}`,
      );
    },
  );

  await expectJsonStatus(
    `${baseUrl}/api/chat/events`,
    {
      method: 'POST',
      headers: {
        ...externalHeaders,
        'content-type': 'application/json',
        'x-api-secret': requestSecret,
      },
      body: JSON.stringify({
        text: '/rename Built HTTP Renamed',
        connector: 'tui',
        actorId: tuiActorId,
        conversationId: tuiConversationId,
        session: tuiSessionId,
      }),
    },
    200,
    'chat event tui /rename command with secret',
    (body) => {
      assertJson(
        body.result?.text === `Renamed session ${tuiSessionId} to "Built HTTP Renamed".` &&
          body.result?.command?.name === 'rename' &&
          body.session?.id === tuiSessionId,
        `tui /rename command did not include the expected command result.\n${JSON.stringify(body).slice(0, 1200)}`,
      );
    },
  );

  await expectJsonStatus(
    `${baseUrl}/api/chat/events`,
    {
      method: 'POST',
      headers: {
        ...externalHeaders,
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
    403,
    'chat event denied explicit session resume with secret',
    (body) => {
      assertJson(
        body.error?.includes(`Session ${tuiSessionId} is not available for this actor or conversation.`),
        `denied explicit session resume did not include the expected refusal.\n${JSON.stringify(body).slice(0, 1200)}`,
      );
    },
  );

  await expectJsonStatus(
    `${baseUrl}/api/chat/events`,
    {
      method: 'POST',
      headers: {
        ...externalHeaders,
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
    200,
    'chat event spoofed connector /new command with secret',
    (body) => {
      assertJson(
        body.result?.text?.includes('/new telegram notes is handled by the web client session controls') &&
          body.result?.command?.name === 'new',
        `spoofed connector /new command did not include the expected web-safe command result.\n${JSON.stringify(body).slice(0, 1200)}`,
      );
    },
  );

  await expectJsonStatus(
    `${baseUrl}/api/chat/events`,
    {
      method: 'POST',
      headers: {
        ...externalHeaders,
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
    200,
    'chat event compact command with secret',
    (body) => {
      assertJson(
        body.result?.text?.includes('Compacted session') &&
          body.result?.command?.name === 'compact' &&
          body.result?.contextBudget?.compactedBeforePrompt === true,
        `compact command did not include the expected durable compact response.\n${JSON.stringify(body).slice(0, 1200)}`,
      );
    },
  );

  const missingRunId = 'agent:orchestrator:built-http-missing-run';
  await expectStatus(`${baseUrl}/runs/${encodeURIComponent(missingRunId)}`, { method: 'GET', headers: externalHeaders }, 401, 'run lookup without secret');
  await expectStatus(
    `${baseUrl}/runs/${encodeURIComponent(missingRunId)}`,
    {
      method: 'GET',
      headers: { ...externalHeaders, 'x-api-secret': requestSecret },
    },
    404,
    'missing run lookup with secret',
  );

  await expectStatus(
    `${baseUrl}/api/telemetry/runs/${encodeURIComponent(missingRunId)}`,
    {
      method: 'GET',
      headers: { ...externalHeaders, 'x-api-secret': requestSecret },
    },
    404,
    'missing telemetry run with secret',
  );

  await expectJsonStatus(
    `${baseUrl}/api/telemetry/runs`,
    {
      method: 'GET',
      headers: { ...externalHeaders, 'x-api-secret': requestSecret },
    },
    200,
    'telemetry run list with secret',
    (body) => {
      assertJson(Array.isArray(body.runs), 'telemetry snapshot did not include a runs array');
      assertJson(typeof body.unscopedEventCount === 'number', 'telemetry snapshot did not include unscopedEventCount');
    },
  );

  console.log('Built HTTP integration test passed, including isolated fresh-session lifecycle checks.');
} finally {
  try {
    if (child) {
      await stopChild(child);
    }
  } finally {
    if (originalConfig !== undefined) {
      writeFileSync(configPath, originalConfig);
    }
    rmSync(codingWorkspaceRoot, { recursive: true, force: true });
    await releaseArtifactLock();
  }
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

    await sleep(250);
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

function countNormalizedEventsForActors(databasePath, actorIds) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const placeholders = actorIds.map(() => '?').join(', ');
    const row = database
      .prepare(`SELECT COUNT(*) AS count FROM normalized_message_events WHERE actor_id IN (${placeholders})`)
      .get(...actorIds);
    return Number(row.count);
  } finally {
    database.close();
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
