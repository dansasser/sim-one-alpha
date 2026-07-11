import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflowSource = readFileSync('src/workflows/github-auth.ts', 'utf8');
const toolSource = readFileSync(
  'src/engine/workers/coding-worker/github/github-auth-tools.ts',
  'utf8',
);

test('GitHub auth workflow validates runtime actions instead of treating unknown actions as start', () => {
  assert.match(workflowSource, /Unsupported GitHub auth action/);
  assert.match(workflowSource, /case ['"]status['"]/);
  assert.match(workflowSource, /case ['"]start['"]/);
});

test('GitHub auth workflow checks live status before starting another browser login', () => {
  assert.match(workflowSource, /case ['"]start['"]:[\s\S]*currentStatus = await authService\.status/);
});

test('GitHub auth workflow honors every Coding Worker workspace-root alias', () => {
  assert.match(workflowSource, /GOROMBO_WORKSPACE_ROOT/);
  assert.match(workflowSource, /GOROMBO_CODING_WORKSPACE_ROOT/);
  assert.match(workflowSource, /GOROMBO_CODING_REPO_PATH/);
});

test('GitHub auth tool and workflow use one shared auth-session id utility', () => {
  assert.match(workflowSource, /createGithubAuthSessionId/);
  assert.match(toolSource, /createGithubAuthSessionId/);
  assert.doesNotMatch(workflowSource, /function stableSessionId/);
  assert.doesNotMatch(toolSource, /function stableSessionId/);
});
