import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const text = process.argv.slice(2).join(' ').trim() || 'Research the current request.';
const payload = JSON.stringify({
  text,
  actorId: process.env.GOROMBO_RESEARCH_ACTOR_ID || 'local-user',
  conversationId: process.env.GOROMBO_RESEARCH_CONVERSATION_ID || 'local-research',
  session: process.env.GOROMBO_RESEARCH_SESSION || 'local-research',
  maxContextTokens: Number(process.env.GOROMBO_RESEARCH_MAX_CONTEXT_TOKENS || 2000),
  webFetch: process.env.GOROMBO_RESEARCH_WEB_FETCH || 'auto',
  fetchTopK: Number(process.env.GOROMBO_RESEARCH_FETCH_TOP_K || 1),
});

const cli = path.resolve('node_modules/@flue/cli/bin/flue.mjs');
const result = spawnSync(
  process.execPath,
  [cli, 'run', 'research', '--target', 'node', '--payload', payload],
  {
    stdio: 'inherit',
    shell: false,
  },
);

if (result.error) {
  console.error(result.error);
}

process.exit(result.status ?? 1);
