import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  detectPackageManager,
  packageManagerRunCommand,
  packageManagerTestCommand,
} from '../engine/workers/coding-worker/repo/package-manager.js';

test('detectPackageManager returns npm when package-lock.json is present', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'coding-worker-npm-detect-'));

  try {
    writeFileSync(join(repoPath, 'package-lock.json'), '{ "name": "fixture", "lockfileVersion": 3 }\n');

    assert.equal(detectPackageManager(repoPath), 'npm');
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test('packageManagerRunCommand builds npm run <script> without corepack', () => {
  assert.equal(packageManagerRunCommand('npm', 'test'), 'npm run test');
  assert.equal(packageManagerRunCommand('npm', 'build'), 'npm run build');
  assert.equal(packageManagerRunCommand('npm', 'typecheck'), 'npm run typecheck');
});

test('packageManagerTestCommand returns npm test', () => {
  assert.equal(packageManagerTestCommand('npm'), 'npm test');
});
