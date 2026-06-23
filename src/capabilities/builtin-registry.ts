import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CapabilityKind } from './types.js';

export interface BuiltinRegistry {
  tools: string[];
  subagents: string[];
  skills: string[];
  mcpServers: string[];
}

const builtinRegistryFilename = 'builtin-capabilities.json';

let cachedRegistry: BuiltinRegistry | undefined;

export function loadBuiltinRegistry(): BuiltinRegistry {
  if (cachedRegistry) {
    return cachedRegistry;
  }

  const registryPath = resolveBuiltinRegistryPath();

  if (!existsSync(registryPath)) {
    console.warn(`[capabilities] Builtin registry not found at ${registryPath} — collision detection disabled until build runs generate-builtin-registry.mjs`);
    cachedRegistry = { tools: [], subagents: [], skills: [], mcpServers: [] };
    return cachedRegistry;
  }

  try {
    const content = readFileSync(registryPath, 'utf8');
    const parsed = JSON.parse(content) as BuiltinRegistry;
    cachedRegistry = {
      tools: Array.isArray(parsed.tools) ? parsed.tools : [],
      subagents: Array.isArray(parsed.subagents) ? parsed.subagents : [],
      skills: Array.isArray(parsed.skills) ? parsed.skills : [],
      mcpServers: Array.isArray(parsed.mcpServers) ? parsed.mcpServers : [],
    };
    return cachedRegistry;
  } catch {
    cachedRegistry = { tools: [], subagents: [], skills: [], mcpServers: [] };
    return cachedRegistry;
  }
}

export function isBuiltinName(kind: CapabilityKind, id: string): boolean {
  const registry = loadBuiltinRegistry();
  return (
    registry.tools.includes(id) ||
    registry.subagents.includes(id) ||
    registry.skills.includes(id) ||
    registry.mcpServers.includes(id)
  );
}

export function getBuiltinNames(kind?: CapabilityKind): string[] {
  const registry = loadBuiltinRegistry();
  if (kind) {
    return getNamesForKind(registry, kind);
  }
  return [...registry.tools, ...registry.subagents, ...registry.skills, ...registry.mcpServers];
}

function getNamesForKind(registry: BuiltinRegistry, kind: CapabilityKind): string[] {
  switch (kind) {
    case 'tool':
      return registry.tools;
    case 'worker':
      return registry.subagents;
    case 'skill':
      return registry.skills;
    case 'mcp':
      return registry.mcpServers;
  }
}

function resolveBuiltinRegistryPath(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDirectory, '..', '..', builtinRegistryFilename),
    resolve(moduleDirectory, '..', '..', 'dist', builtinRegistryFilename),
    resolve(process.cwd(), 'dist', builtinRegistryFilename),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0];
}