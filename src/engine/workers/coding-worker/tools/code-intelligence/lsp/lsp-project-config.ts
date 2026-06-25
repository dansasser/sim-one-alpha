import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface LspProjectConfig {
  projectRoot: string;
  languageId: string;
  serverOptions?: Record<string, unknown>;
}

export interface DetectProjectConfigInput {
  workspaceRoot: string;
  filePath: string;
  languageId: string;
}

export function detectProjectConfig(input: DetectProjectConfigInput): LspProjectConfig {
  const projectRoot = findProjectRoot(input.workspaceRoot, input.filePath, input.languageId);
  const serverOptions = buildServerOptions(projectRoot, input.languageId);

  return {
    projectRoot,
    languageId: input.languageId,
    serverOptions,
  };
}

function findProjectRoot(workspaceRoot: string, filePath: string, languageId: string): string {
  const markers = languageMarkers[languageId] ?? languageMarkers.default;
  let current = resolve(workspaceRoot, filePath);
  const stop = resolve(workspaceRoot);

  while (current !== stop) {
    const parent = join(current, '..');
    if (parent === current) {
      break;
    }
    for (const marker of markers) {
      if (existsSync(join(parent, marker))) {
        return parent;
      }
    }
    current = parent;
  }

  return stop;
}

function buildServerOptions(projectRoot: string, languageId: string): Record<string, unknown> {
  if (languageId === 'typescript' || languageId === 'javascript' || languageId === 'astro') {
    return {
      tsc: existsSync(join(projectRoot, 'tsconfig.json'))
        ? { configFile: join(projectRoot, 'tsconfig.json') }
        : undefined,
    };
  }

  if (languageId === 'python') {
    const venv = findPythonVenv(projectRoot);
    return venv ? { pythonPath: venv } : {};
  }

  return {};
}

function findPythonVenv(projectRoot: string): string | undefined {
  const candidates = ['.venv/bin/python', 'venv/bin/python', '.venv/Scripts/python.exe', 'venv/Scripts/python.exe'];
  for (const candidate of candidates) {
    const path = join(projectRoot, candidate);
    if (existsSync(path)) {
      return path;
    }
  }
  return undefined;
}

const languageMarkers: Record<string, string[]> = {
  typescript: ['tsconfig.json', 'package.json'],
  javascript: ['package.json'],
  astro: ['astro.config.mjs', 'astro.config.ts', 'astro.config.js', 'tsconfig.json', 'package.json'],
  python: ['pyproject.toml', 'requirements.txt', 'setup.py'],
  default: ['package.json', 'pyproject.toml'],
};
