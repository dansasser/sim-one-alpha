import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const serverDir = '.gorombo/sim-one-alpha';
const serverPath = join(serverDir, 'server.mjs');
const tuiBinaryName = process.platform === 'win32' ? 'sim-one-ratatui-tui.exe' : 'sim-one-ratatui-tui';
const tuiPath = join('.gorombo', 'sim-one-ratatui', tuiBinaryName);
const simOneBinaryName = process.platform === 'win32' ? 'sim-one.cmd' : 'sim-one';
const simOnePath = join('.gorombo', 'sim-one-cli', simOneBinaryName);

if (!existsSync(serverPath)) {
  throw new Error(`${serverPath} does not exist. Run pnpm run build before the Ratatui product smoke test.`);
}

if (!existsSync(tuiPath)) {
  throw new Error(`${tuiPath} does not exist. Run pnpm run build:tui:ratatui before the Ratatui product smoke test.`);
}

if (!existsSync(simOnePath)) {
  throw new Error(`${simOnePath} does not exist. Run pnpm run build:cli before the Ratatui product smoke test.`);
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
  config.storage = {
    ...(config.storage ?? {}),
    flueDatabasePath: join(codingWorkspaceRoot, 'flue.sqlite'),
    sessionDatabasePath: join(codingWorkspaceRoot, 'sessions.sqlite'),
    vectorStorePath: join(codingWorkspaceRoot, 'vectors'),
  };
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
    GOROMBO_CAPABILITY_DB_PATH: join(codingWorkspaceRoot, 'capabilities.sqlite'),
    GOROMBO_CAPABILITIES_DIR: join(codingWorkspaceRoot, 'capabilities'),
    GOROMBO_TEST_MODE: '1',
  };
  if (!childEnv.NVM_DIR && process.env.HOME) {
    childEnv.NVM_DIR = join(process.env.HOME, '.nvm');
  }

  await assertProductCommandRouting(childEnv);
  await assertDefaultProductCommandStartsCleanStartup(childEnv);
  await assertInteractivePromptInput(childEnv);
  await assertVisibleFinalBeforeHttpSettlement(childEnv);

  const firstStartup = await runFreshStartup(childEnv, 'default launch 1');
  const firstSessionId = firstStartup.sessionId;
  const secondStartup = await runFreshStartup(childEnv, 'default launch 2');
  const secondSessionId = secondStartup.sessionId;
  if (firstSessionId === secondSessionId) {
    throw new Error(`default TUI launch reused session ${firstSessionId}`);
  }
  assertFreshStartupDatabase(
    join(codingWorkspaceRoot, 'sessions.sqlite'),
    [firstSessionId, secondSessionId],
  );
  console.log(`[ratatui-product] default launch 1 created a fresh session ${firstSessionId}.`);
  console.log(`[ratatui-product] default launch 2 created a different fresh session ${secondSessionId}.`);
  console.log('[ratatui-product] startup emitted no lifecycle slash commands.');

  const createSessionSmoke = await runProductCommand(
    ['--port', String(port)],
    {
      ...childEnv,
      SIM_ONE_TUI_TEST_PROMPTS: [
        '/session',
        '/new Smoke Session',
        '/session',
        '/compact',
        '/clear Smoke Cleared',
        '/session',
        '/sessions',
        `/resume ${firstSessionId}`,
        '/rename Smoke Session Renamed',
        '/exit',
      ].join('\n'),
    },
    240_000,
  );
  stdout = createSessionSmoke.stdout;
  stderr = createSessionSmoke.stderr;
  const sessionMatch = /Started new session (tui-[^.]+)\./.exec(stdout);
  if (!sessionMatch?.[1]) {
    throw new Error(`Ratatui product session smoke did not create a TUI session.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  const sessionId = sessionMatch[1];
  assertOutputIncludes(stdout, `system: current session ${sessionId}`, 'session command did not show the active session');
  assertOutputIncludes(stdout, `assistant: Compacted session ${sessionId}.`, 'compact command did not compact the active session');
  const clearMatch = /Cleared conversation\. Started new session (tui-[^.]+)\./.exec(stdout);
  if (!clearMatch?.[1]) {
    throw new Error(`Ratatui product session smoke did not clear into a new TUI session.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  const clearedSessionId = clearMatch[1];
  if (clearedSessionId === sessionId) {
    throw new Error(`Ratatui /clear reused the old session id ${sessionId}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  assertOutputIncludes(stdout, `system: current session ${clearedSessionId}`, 'session command did not show the cleared active session');
  assertOutputIncludes(stdout, 'system: recent sessions', 'sessions command did not list scoped TUI sessions');
  assertOutputIncludes(stdout, `assistant: Resumed session ${firstSessionId}.`, 'resume command did not resume the first fresh session');
  assertOutputIncludes(stdout, `assistant: Renamed session ${firstSessionId} to "Smoke Session Renamed".`, 'rename command did not rename the resumed session');
  assertOutputIncludes(stdout, '\nSIM-ONE Alpha - Smoke Session Renamed\n', 'rename command did not update the product header with the explicit name');
  assertOutputIncludes(stdout, 'session: Smoke Session Renamed', 'rename command did not replace the status-bar session id with the explicit title');
  assertOutputIncludes(stdout, `Exited SIM-ONE Alpha TUI. Session: ${firstSessionId}`, 'exit command did not print the resumed session id');

  const eventsBeforeExplicitResume = countNormalizedEventsForSession(
    join(codingWorkspaceRoot, 'sessions.sqlite'),
    firstSessionId,
  );
  const explicitResumeSmoke = await runProductCommand(
    ['--port', String(port), '--session', firstSessionId],
    {
      ...childEnv,
      SIM_ONE_TUI_TEST_PROMPTS: '/exit',
    },
    240_000,
  );
  stdout = explicitResumeSmoke.stdout;
  stderr = explicitResumeSmoke.stderr;
  assertOutputIncludes(stdout, `preflight: resumed TUI session ${firstSessionId}`, 'explicit --session did not validate and resume the requested session');
  assertOutputIncludes(stdout, '\nSIM-ONE Alpha - Smoke Session Renamed\nSIM-ONE Alpha | session: Smoke Session Renamed |', 'explicit --session did not restore the named header and status');
  assertOutputIncludes(stdout, `Exited SIM-ONE Alpha TUI. Session: ${firstSessionId}`, 'explicit --session exit did not print the requested session id');
  if (stdout.includes('preflight: created fresh TUI session')) {
    throw new Error(`explicit --session created a fresh session.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  const eventsAfterExplicitResume = countNormalizedEventsForSession(
    join(codingWorkspaceRoot, 'sessions.sqlite'),
    firstSessionId,
  );
  if (eventsAfterExplicitResume !== eventsBeforeExplicitResume) {
    throw new Error(`explicit --session appended a startup greeting to ${firstSessionId}`);
  }

  console.log(`[ratatui-product] explicit --session resumed the requested session ${firstSessionId} without a greeting.`);
  console.log('[ratatui-product] session commands and existing interactive controls passed.');
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

async function runFreshStartup(env, label) {
  const result = await runProductCommand(
    ['--port', String(port)],
    {
      ...env,
      SIM_ONE_TUI_TEST_STARTUP: '1',
    },
    240_000,
  );
  stdout = result.stdout;
  stderr = result.stderr;
  assertOutputIncludes(stdout, 'preflight: gateway ready', `${label} did not show gateway preflight`);
  assertOutputIncludes(stdout, 'preflight: all systems go', `${label} did not show all-systems-go preflight`);
  assertOutputIncludes(stdout, 'assistant:', `${label} did not render an agent greeting`);
  const sessionMatch = /preflight: created fresh TUI session (tui-[^\s]+)/.exec(stdout);
  if (!sessionMatch?.[1]) {
    throw new Error(`${label} did not report a fresh TUI session id.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  const lastStartupTranscriptLine = lastTranscriptLine(stdout);
  if (!lastStartupTranscriptLine?.startsWith('assistant:')) {
    throw new Error(`${label} did not leave the greeting as the last transcript line. Last transcript line: ${lastStartupTranscriptLine ?? '(none)'}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  if (/session:\s*primary/i.test(stdout)) {
    throw new Error(`${label} rendered the old primary session default.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  if (/context 0[1-9]|scroll test row|placeholder/i.test(stdout)) {
    throw new Error(`${label} rendered scaffold or placeholder transcript content.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  if (stdout.includes('This is an automatic SIM-ONE Alpha local Ratatui TUI startup event')) {
    throw new Error(`${label} exposed the internal startup prompt as a session title.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  assertOutputIncludes(stdout, '\nSIM-ONE Alpha\nSIM-ONE Alpha | session:', `${label} did not use the product-only header or preserve the status bar`);
  return { ...result, sessionId: sessionMatch[1] };
}

function assertFreshStartupDatabase(databasePath, sessionIds) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const placeholders = sessionIds.map(() => '?').join(', ');
    const rows = database
      .prepare(
        `SELECT session_id AS sessionId, text
         FROM normalized_message_events
         WHERE session_id IN (${placeholders})
         ORDER BY received_at, event_id`,
      )
      .all(...sessionIds);
    for (const sessionId of sessionIds) {
      const sessionRows = rows.filter((row) => row.sessionId === sessionId);
      if (sessionRows.length !== 1) {
        throw new Error(`fresh startup session ${sessionId} recorded ${sessionRows.length} normalized events instead of one greeting`);
      }
      const greeting = String(sessionRows[0].text);
      if (!greeting.includes('automatic SIM-ONE Alpha local Ratatui TUI startup event') || !greeting.includes('greeting-preflight')) {
        throw new Error(`fresh startup session ${sessionId} did not record the greeting as its first normal event`);
      }
    }
    const lifecycleSlash = rows.find((row) => /^\/(?:session|new|clear)(?:\s|$)/.test(String(row.text).trim()));
    if (lifecycleSlash) {
      throw new Error(`startup recorded lifecycle slash command ${lifecycleSlash.text} in ${lifecycleSlash.sessionId}`);
    }
  } finally {
    database.close();
  }
}

function countNormalizedEventsForSession(databasePath, sessionId) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database
      .prepare('SELECT COUNT(*) AS count FROM normalized_message_events WHERE session_id = ?')
      .get(sessionId);
    return Number(row.count);
  } finally {
    database.close();
  }
}

async function assertDefaultProductCommandStartsCleanStartup(env) {
  const fakeTuiPath = join(codingWorkspaceRoot, process.platform === 'win32' ? 'fake-tui.cmd' : 'fake-tui');
  if (process.platform === 'win32') {
    writeFileSync(fakeTuiPath, `@echo off\r\n"${process.execPath}" -e "console.log(JSON.stringify(process.argv.slice(1)))" %*\r\n`);
  } else {
    writeFileSync(fakeTuiPath, `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`);
    chmodSync(fakeTuiPath, 0o755);
  }

  const defaultLaunch = await runProductCommand(
    ['--port', String(port)],
    { ...env, SIM_ONE_TUI_PATH: fakeTuiPath },
    30_000,
  );
  const defaultArgs = parseForwardedArgs(defaultLaunch.stdout);
  if (defaultArgs.includes('--session')) {
    throw new Error(`default sim-one launch forwarded --session instead of letting Ratatui create a fresh session.\nstdout:\n${defaultLaunch.stdout}\nstderr:\n${defaultLaunch.stderr}`);
  }

  const explicitLaunch = await runProductCommand(
    ['--port', String(port), '--session', 'tui-explicit-session'],
    { ...env, SIM_ONE_TUI_PATH: fakeTuiPath },
    30_000,
  );
  const explicitArgs = parseForwardedArgs(explicitLaunch.stdout);
  if (!explicitArgs.includes('--session') || !explicitArgs.includes('tui-explicit-session')) {
    throw new Error(`explicit sim-one --session was not forwarded to Ratatui.\nstdout:\n${explicitLaunch.stdout}\nstderr:\n${explicitLaunch.stderr}`);
  }
}

async function assertInteractivePromptInput(env) {
  if (process.platform === 'win32') {
    console.log('[ratatui-interactive] PTY smoke skipped on Windows; Rust terminal-event integration tests remain active.');
    return;
  }

  const command = spawn('python3', ['scripts/test-ratatui-interactive.py'], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let commandStdout = '';
  let commandStderr = '';
  command.stdout.on('data', (chunk) => {
    commandStdout += String(chunk);
  });
  command.stderr.on('data', (chunk) => {
    commandStderr += String(chunk);
  });
  const exitCode = await waitForClose(command, 30_000);
  if (exitCode !== 0) {
    throw new Error(`Ratatui interactive product smoke failed with exit ${exitCode}\nstdout:\n${commandStdout}\nstderr:\n${commandStderr}`);
  }
  process.stdout.write(commandStdout);
}

async function assertVisibleFinalBeforeHttpSettlement(env) {
  if (process.platform === 'win32') {
    console.log('[ratatui-visible-final] PTY smoke skipped on Windows; Rust framebuffer coverage remains active.');
    return;
  }

  const command = spawn('python3', ['scripts/test-ratatui-visible-final.py'], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let commandStdout = '';
  let commandStderr = '';
  command.stdout.on('data', (chunk) => {
    commandStdout += String(chunk);
  });
  command.stderr.on('data', (chunk) => {
    commandStderr += String(chunk);
  });
  const exitCode = await waitForClose(command, 30_000);
  if (exitCode !== 0) {
    throw new Error(`Ratatui visible-final product smoke failed with exit ${exitCode}\nstdout:\n${commandStdout}\nstderr:\n${commandStderr}`);
  }
  process.stdout.write(commandStdout);
}

function parseForwardedArgs(stdout) {
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!line) throw new Error(`fake TUI did not print forwarded args.\nstdout:\n${stdout}`);
  try {
    const args = JSON.parse(line);
    if (!Array.isArray(args)) throw new Error('not an array');
    return args;
  } catch (error) {
    throw new Error(`fake TUI printed invalid forwarded args: ${error.message}\nstdout:\n${stdout}`);
  }
}

function lastTranscriptLine(stdout) {
  return stdout
    .trim()
    .split(/\r?\n/)
    .filter((line) => /^(system|preflight|assistant|operation|turn|thinking|tool|task|error|you):/.test(line))
    .at(-1);
}

async function assertProductCommandRouting(env) {
  const help = await runProductCommand(['--help'], env, 30_000);
  if (help.exitCode !== 0) {
    throw new Error(`sim-one --help failed with exit ${help.exitCode}\nstdout:\n${help.stdout}\nstderr:\n${help.stderr}`);
  }
  if (!help.stdout.includes('SIM-ONE Alpha') || !help.stdout.includes('skill')) {
    throw new Error(`sim-one --help did not expose product CLI help.\nstdout:\n${help.stdout}\nstderr:\n${help.stderr}`);
  }

  for (const kind of ['skill', 'tool', 'worker', 'mcp']) {
    const result = await runProductCommand([kind, 'list'], env, 30_000);
    if (result.exitCode !== 0) {
      throw new Error(`sim-one ${kind} list failed with exit ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (error) {
      throw new Error(`sim-one ${kind} list did not return JSON: ${error.message}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`sim-one ${kind} list returned non-array JSON.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    }
  }
}

function spawnProductCommand(args, env) {
  return spawn(simOnePath, args, {
    cwd: process.cwd(),
    env,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function runProductCommand(args, env, timeoutMs) {
  const command = spawnProductCommand(args, env);
  let commandStdout = '';
  let commandStderr = '';
  command.stdout.on('data', (chunk) => {
    commandStdout += String(chunk);
  });
  command.stderr.on('data', (chunk) => {
    commandStderr += String(chunk);
  });
  const exitCode = await waitForClose(command, timeoutMs);
  if (exitCode !== 0) {
    throw new Error(`sim-one ${args.join(' ')} failed with exit ${exitCode}\nstdout:\n${commandStdout}\nstderr:\n${commandStderr}`);
  }
  return { exitCode, stdout: commandStdout, stderr: commandStderr };
}

function assertOutputIncludes(output, expected, label) {
  if (!output.includes(expected)) {
    throw new Error(`${label}; expected output to include ${JSON.stringify(expected)}.\nstdout:\n${output}\nstderr:\n${stderr}`);
  }
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
