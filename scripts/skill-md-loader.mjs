import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function load(url, context, nextLoad) {
  if (!url.endsWith('/SKILL.md')) {
    return nextLoad(url, context);
  }

  const path = fileURLToPath(url);
  const content = readFileSync(path, 'utf8');
  const frontmatter = parseFrontmatter(content, path);
  const source = [
    'export default {',
    '  __flueSkillReference: true,',
    `  id: ${JSON.stringify(frontmatter.name)},`,
    `  name: ${JSON.stringify(frontmatter.name)},`,
    `  description: ${JSON.stringify(frontmatter.description)},`,
    '};',
    '',
  ].join('\n');

  return {
    format: 'module',
    shortCircuit: true,
    source,
  };
}

function parseFrontmatter(content, path) {
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!match) {
    throw new Error(`SKILL.md is missing YAML frontmatter: ${path}`);
  }

  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
    fields[key] = value;
  }

  if (!fields.name || !fields.description) {
    throw new Error(`SKILL.md frontmatter must define name and description: ${path}`);
  }

  return fields;
}
