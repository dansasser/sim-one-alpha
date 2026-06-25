import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

/**
 * Build-time script that scans source code and generates
 * .gorombo/sim-one-alpha/builtin-capabilities.json listing all built-in tool names,
 * subagent names, skill names, and MCP server names.
 *
 * Runs after `flue build` and before copy-runtime-config.mjs in the
 * build chain. Output is consumed at runtime to distinguish built-in
 * capabilities from user-installed ones.
 */

const TOOL_DIRS = [
  resolve(repoRoot, 'src/engine/tools'),
  resolve(repoRoot, 'src/api/channels'),
];
const WORKER_ROOT = resolve(repoRoot, 'src/engine/workers');
const ORCHESTRATOR_FILE = resolve(repoRoot, 'src/engine/agents/orchestrator.ts');
const REGISTRY_FILE = resolve(repoRoot, 'src/engine/registries/default-registries.ts');

/**
 * Recursively collect .ts files under a directory.
 */
function collectTsFiles(dir, accumulator = []) {
  if (!existsSync(dir)) return accumulator;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTsFiles(fullPath, accumulator);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      accumulator.push(fullPath);
    }
  }
  return accumulator;
}

/**
 * Extract the `name:` string literal that appears as the first property
 * of every `defineTool({ ... })` block in the given file content.
 *
 * Regex strategy: match `defineTool({` then capture the next `name: '...'`
 * or `name: "..."` occurrence within the same block. Because `name:` is
 * always the first field in our tool definitions, a non-greedy scan from
 * `defineTool({` to the first `name:` literal is reliable.
 */
function extractToolNames(content) {
  const names = [];
  const defineToolRegex = /defineTool\(\s*\{/g;
  let match;
  while ((match = defineToolRegex.exec(content)) !== null) {
    const startIdx = match.index + match[0].length;
    const tail = content.slice(startIdx);
    const nameMatch = tail.match(/^\s*name:\s*['"]([^'"]+)['"]/);
    if (nameMatch) {
      names.push(nameMatch[1]);
      continue;
    }
    const looseNameMatch = tail.match(/.{0,80}?name:\s*['"]([^'"]+)['"]/);
    if (looseNameMatch) {
      names.push(looseNameMatch[1]);
    }
  }
  return names;
}

/**
 * Extract subagent names from `defineAgentProfile({ name: ... })` blocks.
 * The name field may be a string literal or an identifier referencing a
 * const declared in the same file. When it is an identifier, we resolve
 * it by scanning the file for `const <id> = '...'` or
 * `export const <id> = '...'` declarations.
 */
function extractAgentProfileNames(content) {
  const names = [];
  const defineProfileRegex = /defineAgentProfile\(\s*\{/g;
  let match;
  while ((match = defineProfileRegex.exec(content)) !== null) {
    const startIdx = match.index + match[0].length;
    const tail = content.slice(startIdx);
    const literalMatch = tail.match(/^\s*name:\s*['"]([^'"]+)['"]/);
    if (literalMatch) {
      names.push(literalMatch[1]);
      continue;
    }
    const identifierMatch = tail.match(/^\s*name:\s*([A-Za-z_$][A-Za-z0-9_$]*)/);
    if (identifierMatch) {
      const identifier = identifierMatch[1];
      const resolved = resolveConstString(content, identifier);
      if (resolved) {
        names.push(resolved);
      }
    }
  }
  return names;
}

/**
 * Resolve a string-valued const identifier within a file's content.
 * Matches `export const <id> = '...'` and `const <id> = '...'`.
 */
function resolveConstString(content, identifier) {
  const re = new RegExp(
    `(?:export\\s+)?const\\s+${identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*['"]([^'"]+)['"]`,
  );
  const m = content.match(re);
  return m ? m[1] : null;
}

/**
 * Extract seeded registry ids (tools, skills, agents) from
 * default-registries.ts. These are `id: '...'` fields inside the
 * InMemoryRegistry seed arrays.
 */
function extractRegistryIds(content) {
  const ids = [];
  const idRegex = /id:\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = idRegex.exec(content)) !== null) {
    ids.push(match[1]);
  }
  return ids;
}

/**
 * Scan for imported skills via `import ... with { type: 'skill' }` or
 * similar patterns. The skill name is the directory name from the import
 * path.
 */
function extractImportedSkills(content) {
  const skills = [];
  const importRegex = /import\s+[^;]*?from\s*['"]([^'"]+)['"]\s*with\s*\{\s*type:\s*['"]skill['"]\s*\}/g;
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    const importPath = match[1];
    const segments = importPath.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    if (last) {
      skills.push(last);
    }
  }
  return skills;
}

function uniqueSorted(arr) {
  return Array.from(new Set(arr)).sort();
}

function safeReadFile(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function main() {
  const tools = new Set();
  const subagents = new Set();
  const skills = new Set();

  // 1. Tools: scan src/engine/tools/ (recursive) and src/api/channels/ for defineTool.
  for (const toolDir of TOOL_DIRS) {
    for (const file of collectTsFiles(toolDir)) {
      const content = safeReadFile(file);
      if (!content) continue;
      for (const name of extractToolNames(content)) {
        tools.add(name);
      }
    }
  }

  // 2. Subagents: scan orchestrator and top-level worker files for
  //    defineAgentProfile. Worker-internal subagents under
  //    src/engine/workers/<name>/subagents/ are intentionally excluded — they
  //    are owned by the worker lead and never exposed to the orchestrator.
  const orchestratorContent = safeReadFile(ORCHESTRATOR_FILE);
  if (orchestratorContent) {
    for (const name of extractAgentProfileNames(orchestratorContent)) {
      subagents.add(name);
    }
  }
  if (existsSync(WORKER_ROOT)) {
    for (const entry of readdirSync(WORKER_ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const workerDir = join(WORKER_ROOT, entry.name);
      for (const file of collectTsFiles(workerDir)) {
        const relative = file.slice(workerDir.length + 1);
        if (relative.split(/[/\\]/).includes('subagents')) continue;
        const content = safeReadFile(file);
        if (!content) continue;
        for (const name of extractAgentProfileNames(content)) {
          subagents.add(name);
        }
      }
    }
  }

  // 3. Seeded registry ids from default-registries.ts.
  const registryContent = safeReadFile(REGISTRY_FILE);
  const registryIds = registryContent ? extractRegistryIds(registryContent) : [];
  for (const id of registryIds) {
    if (id === 'main-orchestrator') continue;
    if (id.startsWith('protocol.')) continue;
    if (id.startsWith('memory.') || id.startsWith('rag.')) {
      tools.add(id);
      continue;
    }
    if (id.startsWith('chat.')) {
      skills.add(id);
      continue;
    }
    if (subagents.has(id) || id === 'researcher' || id === 'coding-worker') {
      subagents.add(id);
      continue;
    }
    skills.add(id);
  }

  // 4. Imported skills scan across agents and workers.
  const scanDirsForSkills = [
    resolve(repoRoot, 'src/engine/agents'),
    resolve(repoRoot, 'src/engine/workers'),
  ];
  for (const dir of scanDirsForSkills) {
    for (const file of collectTsFiles(dir)) {
      const content = safeReadFile(file);
      if (!content) continue;
      for (const name of extractImportedSkills(content)) {
        skills.add(name);
      }
    }
  }

  const payload = {
    tools: uniqueSorted([...tools]),
    subagents: uniqueSorted([...subagents]),
    skills: uniqueSorted([...skills]),
    mcpServers: uniqueSorted(['astro-docs']),
  };

  const outputDir = resolve(repoRoot, '.gorombo', 'sim-one-alpha');
  mkdirSync(outputDir, { recursive: true });
  const outputPath = join(outputDir, 'builtin-capabilities.json');
  writeFileSync(outputPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');

  console.log(
    `[builtin-registry] Generated: ${payload.tools.length} tools, ${payload.subagents.length} subagents, ${payload.skills.length} skills, ${payload.mcpServers.length} mcpServers`,
  );
}

main();