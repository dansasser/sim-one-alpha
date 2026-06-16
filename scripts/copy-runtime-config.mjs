import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const source = resolve('src/config/gorombo.config.json');
const includeTscOutput = process.argv.includes('--tsc');
const targets = includeTscOutput
  ? [resolve('.tmp/tsc/config/gorombo.config.json')]
  : [resolve('dist/gorombo.config.json')];

if (!existsSync(source)) {
  throw new Error(`Runtime config source is missing: ${source}`);
}

for (const target of targets) {
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

copyTestFixtures(includeTscOutput ? resolve('.tmp/tsc') : resolve('dist'));
copyWorkspaceDirectories(includeTscOutput ? resolve('.tmp/tsc') : resolve('dist'));

function copyTestFixtures(outputRoot) {
  const fixturesSource = resolve('src/tests/fixtures');
  if (!existsSync(fixturesSource)) {
    return;
  }
  const fixturesTarget = join(outputRoot, 'tests', 'fixtures');
  mkdirSync(fixturesTarget, { recursive: true });
  cpSync(fixturesSource, fixturesTarget, { recursive: true, force: true });
}

function copyWorkspaceDirectories(outputRoot) {
  copyDirectoryIfExists(resolve('src/workspace'), join(outputRoot, 'workspace'));

  const workersRoot = resolve('src/workers');
  if (!existsSync(workersRoot)) {
    return;
  }

  for (const entry of readdirSync(workersRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    copyNestedWorkspaceDirectories(
      join(workersRoot, entry.name),
      join(outputRoot, 'workers', entry.name),
    );
  }
}

function copyNestedWorkspaceDirectories(sourceRoot, targetRoot) {
  copyDirectoryIfExists(join(sourceRoot, 'workspace'), join(targetRoot, 'workspace'));

  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'workspace') {
      continue;
    }

    copyNestedWorkspaceDirectories(join(sourceRoot, entry.name), join(targetRoot, entry.name));
  }
}

function copyDirectoryIfExists(sourceDir, targetDir) {
  if (!existsSync(sourceDir)) {
    return;
  }

  mkdirSync(dirname(targetDir), { recursive: true });
  cpSync(sourceDir, targetDir, { recursive: true, force: true });
}
