import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const workspaceFileOrder = [
  'SECURITY.md',
  'AGENTS.md',
  'IDENTITY.md',
  'SOUL.md',
  'USER.md',
  'TOOLS.md',
  'MEMORY.md',
  'HEARTBEAT.md',
] as const;

export type WorkspaceFileName = (typeof workspaceFileOrder)[number];

export interface ComposeWorkspaceInstructionsOptions {
  workspaceDir: string | URL;
  title: string;
  files?: readonly WorkspaceFileName[];
}

export function composeWorkspaceInstructions({
  workspaceDir,
  title,
  files = workspaceFileOrder,
}: ComposeWorkspaceInstructionsOptions): string {
  const workspacePath = resolveWorkspaceDir(workspaceDir);
  const sections = files.map((fileName) => {
    const filePath = resolveWorkspaceFilePath(workspacePath, fileName);
    const content = readFileSync(filePath, 'utf8').trim();

    return `## ${fileName}\n\n${content}`;
  });

  return [`# ${title}`, ...sections].join('\n\n');
}

export function resolveWorkspaceFilePath(workspacePath: string, fileName: string): string {
  const normalizedWorkspacePath = resolve(workspacePath);
  const filePath = resolve(normalizedWorkspacePath, fileName);
  const relativePath = relative(normalizedWorkspacePath, filePath);

  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`Workspace file resolves outside workspace directory: ${fileName}`);
  }

  return filePath;
}

export function resolveWorkspaceDirectory(relativeWorkspacePath: string, cwd = process.cwd()): string {
  if (isAbsolute(relativeWorkspacePath)) {
    throw new Error(`Workspace directory must be relative: ${relativeWorkspacePath}`);
  }

  const normalizedWorkspacePath = relativeWorkspacePath.replaceAll('\\', '/');
  const candidates = [
    resolveWorkspaceCandidate(cwd, 'src', normalizedWorkspacePath),
    resolveWorkspaceCandidate(cwd, 'dist', normalizedWorkspacePath),
    resolveWorkspaceCandidate(cwd, '.tmp/tsc', normalizedWorkspacePath),
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function resolveWorkspaceDir(workspaceDir: string | URL): string {
  return workspaceDir instanceof URL ? fileURLToPath(workspaceDir) : workspaceDir;
}

function resolveWorkspaceCandidate(cwd: string, rootDirName: string, relativeWorkspacePath: string): string {
  const rootPath = resolve(cwd, rootDirName);
  const workspacePath = resolve(rootPath, relativeWorkspacePath);
  const relativePath = relative(rootPath, workspacePath);

  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`Workspace directory resolves outside ${rootDirName}: ${relativeWorkspacePath}`);
  }

  return workspacePath;
}
