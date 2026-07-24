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
} from '../workspace-loader.js';

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
    const missingFilePath = join(dir, 'TOOLS.md');
    rmSync(missingFilePath);

    assert.throws(
      () =>
        composeWorkspaceInstructions({
          workspaceDir: dir,
          title: 'Missing File Workspace',
        }),
      (error) =>
        error instanceof Error &&
        error.message.includes('Failed to read workspace file TOOLS.md') &&
        error.message.includes(missingFilePath),
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

test('workspace directory resolver falls back to packaged .gorombo runtime workspace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-packaged-runtime-'));

  try {
    const packagedWorkspace = join(dir, '.gorombo', 'sim-one-alpha', 'workspace');
    mkdirSync(packagedWorkspace, { recursive: true });
    writeFileSync(join(packagedWorkspace, '.keep'), '');

    assert.equal(
      resolveWorkspaceDirectory('workspace', dir),
      packagedWorkspace,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workspace directory resolver prefers the packaged runtime over an unrelated cwd workspace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-packaged-precedence-'));

  try {
    const unrelatedWorkspace = join(dir, 'workspace');
    const packagedWorkspace = join(dir, '.gorombo', 'sim-one-alpha', 'workspace');
    mkdirSync(unrelatedWorkspace, { recursive: true });
    mkdirSync(packagedWorkspace, { recursive: true });
    writeFileSync(join(unrelatedWorkspace, '.keep'), '');
    writeFileSync(join(packagedWorkspace, '.keep'), '');

    assert.equal(
      resolveWorkspaceDirectory('workspace', dir),
      packagedWorkspace,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workspace directory resolver finds a workspace directly under cwd', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-runtime-root-'));

  try {
    const runtimeWorkspace = join(dir, 'workers', 'researcher', 'workspace');
    mkdirSync(runtimeWorkspace, { recursive: true });
    writeFileSync(join(runtimeWorkspace, '.keep'), '');

    assert.equal(
      resolveWorkspaceDirectory('workers/researcher/workspace', dir),
      runtimeWorkspace,
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
