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
import { acquireProductArtifactLock } from './product-artifact-lock.mjs';

const serverDir = '.gorombo/sim-one-alpha';
const serverPath = join(serverDir, 'server.mjs');
const tuiBinaryName = process.platform === 'win32' ? 'sim-one-ratatui-tui.exe' : 'sim-one-ratatui-tui';
const tuiPath = join('.gorombo', 'sim-one-ratatui', tuiBinaryName);
const simOneBinaryName = process.platform === 'win32' ? 'sim-one.cmd' : 'sim-one';
const simOnePath = join('.gorombo', 'sim-one-cli', simOneBinaryName);
const transcriptFixture = {
  greeting: 'PACKAGED_SAVED_GREETING',
  promptLineOne: 'PACKAGED_VISIBLE_PROMPT_LINE_ONE',
  promptLineTwo: 'PACKAGED_VISIBLE_PROMPT_LINE_TWO',
  thinking: 'PACKAGED_THINKING_PREVIEW',
  finalLineOne: 'PACKAGED_FINAL_LINE_ONE',
  finalLineTwo: 'PACKAGED_FINAL_LINE_TWO',
  hiddenStartup: 'PACKAGED_INTERNAL_STARTUP_INSTRUCTION',
  hiddenNested: 'PACKAGED_NESTED_WORKER_OUTPUT',
  hiddenToolResult: 'PACKAGED_RAW_TOOL_RESULT',
  hiddenEmptyAssistant: 'PACKAGED_EMPTY_ASSISTANT',
  hiddenSessionCommand: '/rename PACKAGED_PRE_LLM_COMMAND',
};

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
const tuiDiagnosticsPath = join(codingWorkspaceRoot, 'logs', 'sim-one-ratatui.jsonl');
const configPath = join(serverDir, 'gorombo.config.json');
const releaseArtifactLock = await acquireProductArtifactLock();
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
    SIM_ONE_TUI_LOG_PATH: tuiDiagnosticsPath,
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
        '/new Smoke Session',
        '/session',
        '/compact',
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
  assertOutputIncludes(stdout, `Exited SIM-ONE Alpha TUI. Session: ${sessionId}`, 'exit command did not print the new session id');

  const clearSessionSmoke = await runProductCommand(
    ['--port', String(port), '--session', sessionId],
    {
      ...childEnv,
      SIM_ONE_TUI_TEST_PROMPTS: [
        '/clear Smoke Cleared',
        '/session',
        '/sessions',
        '/exit',
      ].join('\n'),
    },
    240_000,
  );
  stdout = clearSessionSmoke.stdout;
  stderr = clearSessionSmoke.stderr;
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

  const resumeSessionSmoke = await runProductCommand(
    ['--port', String(port), '--session', clearedSessionId],
    {
      ...childEnv,
      SIM_ONE_TUI_TEST_PROMPTS: [
        `/resume ${firstSessionId}`,
        '/rename Smoke Session Renamed',
        '/exit',
      ].join('\n'),
    },
    240_000,
  );
  stdout = resumeSessionSmoke.stdout;
  stderr = resumeSessionSmoke.stderr;
  assertOutputIncludes(stdout, `system: Resumed session ${firstSessionId}.`, 'resume command did not resume the first fresh session');
  assertOutputIncludes(stdout, `assistant: Renamed session ${firstSessionId} to "Smoke Session Renamed".`, 'rename command did not rename the resumed session');
  assertOutputIncludes(stdout, '\nSIM-ONE Alpha - Smoke Session Renamed\n', 'rename command did not update the product header with the explicit name');
  assertOutputIncludes(stdout, 'session: Smoke Session Renamed', 'rename command did not replace the status-bar session id with the explicit title');
  assertOutputIncludes(stdout, `Exited SIM-ONE Alpha TUI. Session: ${firstSessionId}`, 'exit command did not print the resumed session id');
  assertSessionCommandStorage(
    join(codingWorkspaceRoot, 'sessions.sqlite'),
    [firstSessionId, sessionId, clearedSessionId],
  );

  seedTranscriptFixture(
    join(codingWorkspaceRoot, 'sessions.sqlite'),
    join(codingWorkspaceRoot, 'flue.sqlite'),
    firstSessionId,
  );
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

  const explicitNameResumeSmoke = await runProductCommand(
    ['--port', String(port), '--session', 'Smoke Session Renamed'],
    {
      ...childEnv,
      SIM_ONE_TUI_TEST_PROMPTS: '/exit',
    },
    240_000,
  );
  stdout = explicitNameResumeSmoke.stdout;
  stderr = explicitNameResumeSmoke.stderr;
  assertOutputIncludes(stdout, `preflight: resumed TUI session ${firstSessionId}`, 'explicit --session name did not resolve to the canonical session id');
  assertOutputIncludes(stdout, '\nSIM-ONE Alpha - Smoke Session Renamed\nSIM-ONE Alpha | session: Smoke Session Renamed |', 'explicit --session name did not restore the named header and status');
  assertOutputIncludes(stdout, `Exited SIM-ONE Alpha TUI. Session: ${firstSessionId}`, 'explicit --session name did not exit with the canonical session id');
  assertPackagedTranscriptResume(stdout);
  const eventsAfterNameResume = countNormalizedEventsForSession(
    join(codingWorkspaceRoot, 'sessions.sqlite'),
    firstSessionId,
  );
  if (eventsAfterNameResume !== eventsBeforeExplicitResume) {
    throw new Error(`explicit --session name appended a startup greeting to ${firstSessionId}`);
  }

  const missingSelector = `missing-${Date.now()}`;
  const fallbackStartup = await runMissingSessionFallback(childEnv, missingSelector);
  assertFreshStartupDatabase(
    join(codingWorkspaceRoot, 'sessions.sqlite'),
    [fallbackStartup.sessionId],
  );
  assertTuiDiagnostics(
    tuiDiagnosticsPath,
    firstSessionId,
    fallbackStartup.sessionId,
    missingSelector,
  );

  console.log(`[ratatui-product] explicit --session resumed the requested session ${firstSessionId} without a greeting.`);
  console.log(`[ratatui-product] explicit --session name resolved to ${firstSessionId} without a greeting.`);
  console.log(`[ratatui-product] missing --session selector created fresh session ${fallbackStartup.sessionId}.`);
  console.log('[ratatui-product] session commands and existing interactive controls passed.');
} finally {
  try {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  } finally {
    writeFileSync(configPath, originalConfig);
    rmSync(codingWorkspaceRoot, { recursive: true, force: true });
    await releaseArtifactLock();
  }
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

async function runMissingSessionFallback(env, selector) {
  const result = await runProductCommand(
    ['--port', String(port), '--session', selector],
    {
      ...env,
      SIM_ONE_TUI_TEST_STARTUP: '1',
    },
    240_000,
  );
  const fallbackLine = `preflight: session ${selector} was not found; created fresh TUI session `;
  assertOutputIncludes(result.stdout, fallbackLine, 'missing --session selector did not report fresh fallback');
  assertOutputIncludes(result.stdout, 'preflight: all systems go', 'missing --session selector did not complete preflight');
  assertOutputIncludes(result.stdout, 'assistant:', 'missing --session selector did not render the fresh greeting');
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sessionMatch = new RegExp(
    `preflight: session ${escapedSelector} was not found; created fresh TUI session (tui-[^\\s]+)`,
  ).exec(result.stdout);
  if (!sessionMatch?.[1]) {
    throw new Error(`missing --session selector did not report its fresh session id.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
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

function assertSessionCommandStorage(databasePath, sessionIds) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const placeholders = sessionIds.map(() => '?').join(', ');
    const rows = database
      .prepare(
        `SELECT text, delivery_kind AS deliveryKind
         FROM normalized_message_events
         WHERE session_id IN (${placeholders})
         ORDER BY received_at, event_id`,
      )
      .all(...sessionIds)
      .filter((row) => /^\/(?:new|clear|resume|rename|compact|session)(?:\s|$)/i.test(String(row.text).trim()));
    if (rows.length === 0) {
      throw new Error('Ratatui product session smoke did not persist any pre-LLM command records.');
    }
    const misclassified = rows.find((row) => row.deliveryKind !== 'session-command');
    if (misclassified) {
      throw new Error(`pre-LLM command was stored as ${misclassified.deliveryKind}: ${misclassified.text}`);
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

function seedTranscriptFixture(sessionDatabasePath, flueDatabasePath, sessionId) {
  const sessionDatabase = new DatabaseSync(sessionDatabasePath);
  const flueDatabase = new DatabaseSync(flueDatabasePath);
  const streamPath = `agents/orchestrator/${sessionId}`;
  const greetingSubmission = 'packaged-greeting-submission';
  const userSubmission = 'packaged-user-submission';
  const now = '2026-07-23T15:00:00.000Z';
  const events = [
    {
      type: 'operation_start',
      operationId: 'packaged-greeting-operation',
      operationKind: 'startup',
      submissionId: greetingSubmission,
      eventIndex: 0,
      timestamp: '2026-07-23T15:00:00.100Z',
    },
    {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: transcriptFixture.greeting }],
      },
      submissionId: greetingSubmission,
      eventIndex: 1,
      timestamp: '2026-07-23T15:00:00.200Z',
    },
    {
      type: 'operation',
      operationId: 'packaged-greeting-operation',
      operationKind: 'startup',
      durationMs: 700,
      isError: false,
      submissionId: greetingSubmission,
      eventIndex: 2,
      timestamp: '2026-07-23T15:00:00.300Z',
    },
    {
      type: 'operation_start',
      operationId: 'packaged-user-operation',
      operationKind: 'prompt',
      submissionId: userSubmission,
      eventIndex: 0,
      timestamp: '2026-07-23T15:01:00.100Z',
    },
    {
      type: 'thinking_start',
      turnId: 'packaged-user-turn',
      submissionId: userSubmission,
      eventIndex: 1,
      timestamp: '2026-07-23T15:01:00.200Z',
    },
    {
      type: 'thinking_delta',
      turnId: 'packaged-user-turn',
      delta: transcriptFixture.thinking,
      submissionId: userSubmission,
      eventIndex: 2,
      timestamp: '2026-07-23T15:01:00.300Z',
    },
    {
      type: 'thinking_end',
      turnId: 'packaged-user-turn',
      submissionId: userSubmission,
      eventIndex: 3,
      timestamp: '2026-07-23T15:01:00.400Z',
    },
    {
      type: 'tool_start',
      toolCallId: 'packaged-tool',
      toolName: 'repository_status',
      submissionId: userSubmission,
      eventIndex: 4,
      timestamp: '2026-07-23T15:01:00.500Z',
    },
    {
      type: 'tool',
      toolCallId: 'packaged-tool',
      toolName: 'repository_status',
      durationMs: 31,
      isError: false,
      result: { text: transcriptFixture.hiddenToolResult },
      submissionId: userSubmission,
      eventIndex: 5,
      timestamp: '2026-07-23T15:01:00.600Z',
    },
    {
      type: 'task_start',
      taskId: 'packaged-task',
      taskName: 'researcher',
      submissionId: userSubmission,
      eventIndex: 6,
      timestamp: '2026-07-23T15:01:00.700Z',
    },
    {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: transcriptFixture.hiddenNested }],
      },
      parentSession: 'default',
      session: 'task:default:packaged-worker',
      submissionId: userSubmission,
      eventIndex: 7,
      timestamp: '2026-07-23T15:01:00.800Z',
    },
    {
      type: 'message_end',
      message: {
        role: 'toolResult',
        content: [{ type: 'text', text: transcriptFixture.hiddenToolResult }],
      },
      submissionId: userSubmission,
      eventIndex: 8,
      timestamp: '2026-07-23T15:01:00.900Z',
    },
    {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        metadata: transcriptFixture.hiddenEmptyAssistant,
      },
      submissionId: userSubmission,
      eventIndex: 9,
      timestamp: '2026-07-23T15:01:01.000Z',
    },
    {
      type: 'task',
      taskId: 'packaged-task',
      taskName: 'researcher',
      durationMs: 1_200,
      isError: false,
      submissionId: userSubmission,
      eventIndex: 10,
      timestamp: '2026-07-23T15:01:01.100Z',
    },
    {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{
          type: 'text',
          text: `**${transcriptFixture.finalLineOne}**\n\n${transcriptFixture.finalLineTwo}`,
        }],
      },
      submissionId: userSubmission,
      eventIndex: 11,
      timestamp: '2026-07-23T15:01:01.200Z',
    },
    {
      type: 'operation',
      operationId: 'packaged-user-operation',
      operationKind: 'prompt',
      durationMs: 5_900,
      isError: false,
      submissionId: userSubmission,
      eventIndex: 12,
      timestamp: '2026-07-23T15:01:01.300Z',
    },
  ];

  try {
    sessionDatabase.exec('BEGIN IMMEDIATE');
    sessionDatabase
      .prepare(
        `UPDATE chat_sessions
         SET origin = 'tui',
             actor_id = 'local-tui',
             conversation_id = 'local-tui',
             thread_id = 'local-tui',
             title = 'Smoke Session Renamed',
             explicit_name = 'Smoke Session Renamed',
             updated_at = ?
         WHERE session_id = ?`,
      )
      .run(now, sessionId);
    sessionDatabase
      .prepare('DELETE FROM normalized_message_events WHERE session_id = ?')
      .run(sessionId);
    const insertPrompt = sessionDatabase.prepare(
      `INSERT INTO normalized_message_events
       (event_id, session_id, connector, message_kind, text, received_at, actor_id,
        actor_display_name, conversation_id, thread_id, client_id, project_id,
        workflow, task, delivery_kind, delivery_id, delivery_submission_id,
        delivery_stream_url, delivery_offset, accepted_at, created_at, updated_at)
       VALUES (?, ?, 'tui', 'chat.message', ?, ?, 'local-tui', 'Local TUI',
               'local-tui', 'local-tui', NULL, NULL, ?, NULL, 'direct-agent',
               ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertPrompt.run(
      'packaged-greeting-event',
      sessionId,
      `This is an automatic SIM-ONE Alpha local Ratatui TUI startup event.\n${transcriptFixture.hiddenStartup}`,
      '2026-07-23T15:00:00.000Z',
      'tui.startup-preflight',
      greetingSubmission,
      greetingSubmission,
      `/${streamPath}`,
      '-1',
      '2026-07-23T15:00:00.000Z',
      now,
      now,
    );
    insertPrompt.run(
      'packaged-user-event',
      sessionId,
      `${transcriptFixture.promptLineOne}\n${transcriptFixture.promptLineTwo}`,
      '2026-07-23T15:01:00.000Z',
      null,
      userSubmission,
      userSubmission,
      `/${streamPath}`,
      '0000000000000000_0000000000000002',
      '2026-07-23T15:01:00.000Z',
      now,
      now,
    );
    insertPrompt.run(
      'packaged-legacy-command-event',
      sessionId,
      transcriptFixture.hiddenSessionCommand,
      '2026-07-23T15:02:00.000Z',
      null,
      null,
      null,
      null,
      null,
      null,
      now,
      now,
    );
    sessionDatabase.exec('COMMIT');

    flueDatabase.exec('BEGIN IMMEDIATE');
    flueDatabase
      .prepare('DELETE FROM flue_event_stream_entries WHERE path = ?')
      .run(streamPath);
    flueDatabase
      .prepare('DELETE FROM flue_event_streams WHERE path = ?')
      .run(streamPath);
    flueDatabase
      .prepare(
        'INSERT INTO flue_event_streams (path, next_offset, closed) VALUES (?, ?, 0)',
      )
      .run(streamPath, events.length);
    const insertEvent = flueDatabase.prepare(
      'INSERT INTO flue_event_stream_entries (path, seq, data) VALUES (?, ?, ?)',
    );
    for (const [index, event] of events.entries()) {
      insertEvent.run(streamPath, index, JSON.stringify(event));
    }
    flueDatabase.exec('COMMIT');
  } catch (error) {
    try {
      sessionDatabase.exec('ROLLBACK');
    } catch {}
    try {
      flueDatabase.exec('ROLLBACK');
    } catch {}
    throw error;
  } finally {
    sessionDatabase.close();
    flueDatabase.close();
  }
}

function assertPackagedTranscriptResume(output) {
  for (const visible of [
    transcriptFixture.greeting,
    transcriptFixture.promptLineOne,
    transcriptFixture.promptLineTwo,
    transcriptFixture.thinking,
    transcriptFixture.finalLineOne,
    transcriptFixture.finalLineTwo,
    'operation: prompt completed in 5.9s',
    'tool: repository_status completed in 31ms',
    'task: researcher completed in 1.2s',
  ]) {
    assertOccurrenceCount(output, visible, 1, `restored transcript did not render ${visible} exactly once`);
  }
  for (const hidden of [
    transcriptFixture.hiddenStartup,
    transcriptFixture.hiddenNested,
    transcriptFixture.hiddenToolResult,
    transcriptFixture.hiddenEmptyAssistant,
    transcriptFixture.hiddenSessionCommand,
  ]) {
    assertOccurrenceCount(output, hidden, 0, `restored transcript exposed hidden content ${hidden}`);
  }
  if (/^assistant:\s*$/m.test(output)) {
    throw new Error(`restored transcript rendered an empty assistant block.\nstdout:\n${output}`);
  }
}

function assertOccurrenceCount(output, value, expected, label) {
  const count = output.split(value).length - 1;
  if (count !== expected) {
    throw new Error(`${label}; expected ${expected}, found ${count}.\nstdout:\n${output}`);
  }
}

function assertTuiDiagnostics(path, resumedSessionId, fallbackSessionId, missingSelector) {
  if (!existsSync(path)) {
    throw new Error(`Ratatui diagnostics log was not created at ${path}.`);
  }
  const raw = readFileSync(path, 'utf8');
  const entries = raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const hasEvent = (event, predicate = () => true) =>
    entries.some((entry) => entry.event === event && predicate(entry));

  if (!hasEvent('gateway.ready')) {
    throw new Error('Ratatui diagnostics did not record gateway readiness.');
  }
  if (!hasEvent(
    'session.lifecycle.completed',
    (entry) => entry.outcome === 'name_resolved' && entry.sessionId === resumedSessionId,
  )) {
    throw new Error('Ratatui diagnostics did not record name-to-id session resolution.');
  }
  if (!hasEvent(
    'session.lifecycle.completed',
    (entry) => entry.outcome === 'fresh_fallback' && entry.sessionId === fallbackSessionId,
  )) {
    throw new Error('Ratatui diagnostics did not record missing-selector fresh fallback.');
  }
  if (process.platform !== 'win32') {
    if (!hasEvent('input.ctrl_c', (entry) => entry.action === 'copy_transcript')) {
      throw new Error('Ratatui diagnostics did not distinguish transcript copy from exit.');
    }
  }
  if (!hasEvent('application.exited')) {
    throw new Error('Ratatui diagnostics did not record application exit.');
  }
  for (const privateValue of [
    'Smoke Session Renamed',
    missingSelector,
    'first line updated',
    'keep X tail',
  ]) {
    if (raw.includes(privateValue)) {
      throw new Error(`Ratatui diagnostics persisted private prompt or selector content: ${privateValue}`);
    }
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
    ['--port', String(port), '--session', 'Named Session With Spaces'],
    { ...env, SIM_ONE_TUI_PATH: fakeTuiPath },
    30_000,
  );
  const explicitArgs = parseForwardedArgs(explicitLaunch.stdout);
  if (!explicitArgs.includes('--session') || !explicitArgs.includes('Named Session With Spaces')) {
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
  const command = process.platform === 'win32' ? process.execPath : simOnePath;
  const commandArgs = process.platform === 'win32'
    ? [join('.gorombo', 'sim-one-cli', 'cli.js'), ...args]
    : args;
  return spawn(command, commandArgs, {
    cwd: process.cwd(),
    env,
    shell: false,
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
