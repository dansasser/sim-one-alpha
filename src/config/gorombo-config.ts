import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const goromboRuntimeConfigFilename = 'gorombo.config.json';
export const goromboRuntimeConfigPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  goromboRuntimeConfigFilename,
);
export const goromboSourceConfigPath = resolve(process.cwd(), 'src/config/gorombo.config.json');

export interface GoromboConfig {
  version: 1;
  agent?: {
    name?: string;
  };
  models: GoromboModelConfig;
  orchestrator?: Record<string, unknown>;
  workers?: Record<string, unknown>;
  rag?: Record<string, unknown>;
  memory?: Record<string, unknown>;
  protocols?: Record<string, unknown>;
  gateway?: Record<string, unknown>;
  observability?: Record<string, unknown>;
}

export interface GoromboModelConfig {
  primary: string;
  backup?: string;
}

export interface LoadGoromboConfigOptions {
  config?: GoromboConfig;
}

export function loadGoromboConfig(options: LoadGoromboConfigOptions = {}): GoromboConfig {
  if (options.config) {
    return validateGoromboConfig(options.config, 'inline config');
  }

  const configPath = resolveRuntimeConfigPath();

  if (!configPath) {
    throw new Error(
      `GOROMBO runtime config file not found. Checked: ${runtimeConfigCandidates().join(', ')}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Failed to read GOROMBO runtime config at ${configPath}: ${errorMessage(error)}`);
  }

  return validateGoromboConfig(parsed, configPath);
}

export function validateGoromboConfig(value: unknown, source = 'GOROMBO config'): GoromboConfig {
  if (!isRecord(value)) {
    throw new Error(`${source} must be a JSON object.`);
  }

  if (value.version !== 1) {
    throw new Error(`${source} must declare "version": 1.`);
  }

  if (!isRecord(value.models)) {
    throw new Error(`${source} must define a models object.`);
  }

  const primary = readString(value.models.primary);
  if (!primary) {
    throw new Error(`${source} must define models.primary as a model card key.`);
  }

  const backup = readString(value.models.backup);

  return {
    ...value,
    version: 1,
    models: {
      primary,
      ...(backup ? { backup } : {}),
    },
  } as GoromboConfig;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function resolveRuntimeConfigPath(): string | undefined {
  return runtimeConfigCandidates().find((candidate) => existsSync(candidate));
}

function runtimeConfigCandidates(): string[] {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));

  return [
    resolve(moduleDirectory, goromboRuntimeConfigFilename),
    goromboSourceConfigPath,
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
