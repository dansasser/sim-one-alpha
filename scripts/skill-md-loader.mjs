import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

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

export function parseFrontmatter(content, path) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) {
    throw new Error(`SKILL.md is missing YAML frontmatter: ${path}`);
  }

  let fields;
  try {
    fields = loadYaml(match[1], { filename: path });
  } catch (error) {
    throw new Error(`SKILL.md has invalid YAML frontmatter: ${path}`, { cause: error });
  }

  if (!fields
    || typeof fields !== 'object'
    || Array.isArray(fields)
    || typeof fields.name !== 'string'
    || !fields.name.trim()
    || typeof fields.description !== 'string'
    || !fields.description.trim()) {
    throw new Error(`SKILL.md frontmatter must define name and description: ${path}`);
  }

  return {
    name: fields.name,
    description: fields.description,
  };
}
