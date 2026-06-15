import { existsSync, mkdirSync } from 'node:fs';
import { resolve, isAbsolute, sep } from 'node:path';

function readStringEnv(key: string): string | undefined {
  const value = process.env[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function resolveImageOutputDir(): string {
  const configuredDir = readStringEnv('GOROMBO_IMAGE_OUTPUT_DIR');
  const workspaceRoot =
    readStringEnv('GOROMBO_WORKSPACE_ROOT') ??
    readStringEnv('GOROMBO_CODING_WORKSPACE_ROOT') ??
    process.cwd();
  const dir = configuredDir ? resolve(configuredDir) : resolve(workspaceRoot, 'workspace', 'images');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function resolveImageArtifactFilePath(filePath: string): string {
  const root = resolve(resolveImageOutputDir());
  const resolved = isAbsolute(filePath) ? resolve(filePath) : resolve(root, filePath);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(`Image artifact path ${resolved} is outside the configured image output root ${root}.`);
  }
  return resolved;
}
