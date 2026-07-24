import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('SKILL.md loader accepts CRLF frontmatter', () => {
  const script = [
    "import { parseFrontmatter } from './scripts/skill-md-loader.mjs';",
    "const value = parseFrontmatter('---\\r\\nname: windows-skill\\r\\ndescription: CRLF works\\r\\n---\\r\\nBody\\r\\n', 'fixture');",
    'process.stdout.write(JSON.stringify(value));',
  ].join('');
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    name: 'windows-skill',
    description: 'CRLF works',
  });
});

test('built-in registry reserves a Markdown skill by parent directory name', () => {
  const result = spawnSync(process.execPath, ['scripts/generate-builtin-registry.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);

  const registry = JSON.parse(
    readFileSync('.gorombo/sim-one-alpha/builtin-capabilities.json', 'utf8'),
  ) as { skills?: string[] };
  assert.equal(registry.skills?.includes('greeting-preflight'), true);
  assert.equal(registry.skills?.includes('SKILL.md'), false);
});
