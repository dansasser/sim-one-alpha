import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  composeWorkspaceInstructions,
  resolveWorkspaceDirectory,
  resolveWorkspaceFilePath,
  workspaceFileOrder,
  type WorkspaceFileName,
} from '../persona/workspace-loader.js';

test('workspace loader composes files in workspace order with section headers', () => {
  const dir = makeWorkspaceFixture();

  try {
    const instructions = composeWorkspaceInstructions({
      workspaceDir: dir,
      title: 'Test Workspace',
    });

    assert.match(instructions, /^# Test Workspace/);
    assert.ok(instructions.indexOf('## SECURITY.md') < instructions.indexOf('## AGENTS.md'));
    assert.ok(instructions.indexOf('## AGENTS.md') < instructions.indexOf('## IDENTITY.md'));
    assert.ok(instructions.includes('SECURITY.md content'));
    assert.ok(instructions.includes('HEARTBEAT.md content'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workspace loader reports missing workspace files clearly', () => {
  const dir = makeWorkspaceFixture();

  try {
    rmSync(join(dir, 'TOOLS.md'));

    assert.throws(
      () =>
        composeWorkspaceInstructions({
          workspaceDir: dir,
          title: 'Missing File Workspace',
        }),
      /TOOLS\.md/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workspace file resolution rejects paths outside the workspace directory', () => {
  const dir = makeWorkspaceFixture();

  try {
    assert.throws(
      () => resolveWorkspaceFilePath(dir, '../outside.md' as WorkspaceFileName),
      /outside workspace directory/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workspace directory resolver falls back to dist when src workspace is absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-resolver-'));

  try {
    const distWorkspace = join(dir, 'dist', 'workers', 'researcher', 'workspace');
    mkdirSync(distWorkspace, { recursive: true });
    writeFileSync(join(distWorkspace, '.keep'), '');

    assert.equal(
      resolveWorkspaceDirectory('workers/researcher/workspace', dir),
      distWorkspace,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeWorkspaceFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-loader-'));

  for (const fileName of workspaceFileOrder) {
    writeFileSync(join(dir, fileName), `# ${fileName}\n\n${fileName} content\n`);
  }

  return dir;
}
