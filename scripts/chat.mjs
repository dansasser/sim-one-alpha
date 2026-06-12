import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const resumeIndex = args.indexOf('--resume');
let resumeSession = process.env.GOROMBO_CHAT_SESSION;
let textArgs = args;

if (resumeIndex >= 0) {
  const candidate = args[resumeIndex + 1];
  if (typeof candidate !== 'string' || candidate.startsWith('-')) {
    console.error('Missing session id after --resume. Usage: corepack pnpm run chat:local -- --resume <session-id> <message>');
    process.exit(1);
  }

  resumeSession = candidate;
  textArgs = args.filter((_, index) => index !== resumeIndex && index !== resumeIndex + 1);
}
const text = textArgs.join(' ').trim() || 'Hello';
const payload = JSON.stringify({
  connector: 'tui',
  text,
  actorId: process.env.GOROMBO_CHAT_ACTOR_ID || 'local-user',
  conversationId: process.env.GOROMBO_CHAT_CONVERSATION_ID || 'local-thread',
  ...(resumeSession ? { session: resumeSession } : {}),
});

const cli = path.resolve('node_modules/@flue/cli/bin/flue.mjs');
const result = spawnSync(
  process.execPath,
  [cli, 'run', 'chat', '--target', 'node', '--payload', payload],
  {
    stdio: 'inherit',
    shell: false,
  },
);

if (result.error) {
  console.error(result.error);
}

process.exit(result.status ?? 1);
