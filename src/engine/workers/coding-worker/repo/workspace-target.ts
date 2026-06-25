import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CodingWorkspaceTargetKind } from '../../../../engine/workers/coding-worker/types.js';

export interface CodingWorkspaceTargetInput {
  workspaceRoot?: string;
  targetKind?: CodingWorkspaceTargetKind;
  projectId?: string;
  projectSlug?: string;
  projectRelativePath?: string;
  /**
   * Legacy direct-repository scope. Prefer workspaceRoot plus project metadata.
   */
  repoPath?: string;
}

export interface ResolvedCodingWorkspaceTarget {
  workspaceRoot: string;
  targetKind: CodingWorkspaceTargetKind;
  projectId?: string;
  projectSlug?: string;
  projectRelativePath: string;
  scopePath: string;
  /**
   * Alias for repository-oriented support modules that operate on the selected scope.
   */
  repoPath: string;
  usedLegacyRepoPath: boolean;
}

export type CodingProjectDirectoryKind = 'projects' | 'repos';

export function resolveCodingWorkspaceTarget(
  input: CodingWorkspaceTargetInput,
): ResolvedCodingWorkspaceTarget {
  if (input.repoPath && !input.workspaceRoot && !input.projectRelativePath && !input.projectSlug) {
    const legacyRepoPath = resolve(input.repoPath);
    return {
      workspaceRoot: legacyRepoPath,
      targetKind: input.targetKind ?? 'repo',
      projectId: input.projectId,
      projectSlug: input.projectSlug,
      projectRelativePath: '.',
      scopePath: legacyRepoPath,
      repoPath: legacyRepoPath,
      usedLegacyRepoPath: true,
    };
  }

  const workspaceRoot = resolve(input.workspaceRoot ?? process.cwd());
  const targetKind = resolveTargetKind(input);
  const projectRelativePath = resolveProjectRelativePath(input, targetKind);
  const scopePath =
    targetKind === 'workspace'
      ? workspaceRoot
      : assertInsideWorkspaceRoot(workspaceRoot, projectRelativePath);

  return {
    workspaceRoot,
    targetKind,
    projectId: input.projectId,
    projectSlug: input.projectSlug,
    projectRelativePath,
    scopePath,
    repoPath: scopePath,
    usedLegacyRepoPath: false,
  };
}

export function createProjectRelativePath(input: {
  directoryKind: CodingProjectDirectoryKind;
  projectSlug: string;
}): string {
  return normalizeAgentRelativePath(join(input.directoryKind, normalizeProjectSlug(input.projectSlug)));
}

export function normalizeProjectSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!slug || !/[a-z0-9]/.test(slug)) {
    throw new Error('Project slug must contain at least one letter or number.');
  }

  return slug;
}

export function assertInsideWorkspaceRoot(workspaceRoot: string, path: string): string {
  return assertInsideBoundary(workspaceRoot, path, 'workspace root');
}

export function assertInsideCodingScope(scopePath: string, path: string): string {
  return assertInsideBoundary(scopePath, path, 'coding-worker scope');
}

export function normalizeAgentRelativePath(path: string): string {
  return path.split(/[\\/]+/).filter(Boolean).join('/') || '.';
}

function resolveTargetKind(input: CodingWorkspaceTargetInput): CodingWorkspaceTargetKind {
  if (input.targetKind) {
    return input.targetKind;
  }
  if (input.projectRelativePath) {
    const normalized = normalizeProjectRelativeInput(input.projectRelativePath);
    if (normalized.startsWith('repos/')) {
      return 'repo';
    }
    if (normalized.startsWith('projects/')) {
      return 'project';
    }
  }
  if (input.projectSlug || input.projectId) {
    return 'project';
  }
  return 'workspace';
}

function resolveProjectRelativePath(
  input: CodingWorkspaceTargetInput,
  targetKind: CodingWorkspaceTargetKind,
): string {
  if (targetKind === 'workspace') {
    if (input.projectRelativePath && normalizeProjectRelativeInput(input.projectRelativePath) !== '') {
      throw new Error('workspace targets must not set projectRelativePath.');
    }
    return '.';
  }

  if (input.projectRelativePath) {
    const normalized = normalizeProjectRelativeInput(input.projectRelativePath);
    assertProjectRelativePathMatchesKind(normalized, targetKind);
    return normalized;
  }

  const projectSlug = normalizeProjectSlug(input.projectSlug ?? input.projectId ?? '');
  return createProjectRelativePath({
    directoryKind: targetKind === 'repo' ? 'repos' : 'projects',
    projectSlug,
  });
}

function normalizeProjectRelativeInput(path: string): string {
  if (!path.trim()) {
    throw new Error('projectRelativePath must not be empty.');
  }
  if (isAbsolute(path)) {
    throw new Error('projectRelativePath must be relative to the workspace root.');
  }

  const segments = path.split(/[\\/]+/).filter((segment) => segment.length > 0 && segment !== '.');
  if (segments.some((segment) => segment === '..')) {
    throw new Error('projectRelativePath must not escape the workspace root.');
  }

  return segments.join('/');
}

function assertProjectRelativePathMatchesKind(
  projectRelativePath: string,
  targetKind: Exclude<CodingWorkspaceTargetKind, 'workspace'>,
): void {
  const requiredRoot = targetKind === 'repo' ? 'repos/' : 'projects/';
  if (!projectRelativePath.startsWith(requiredRoot)) {
    throw new Error(
      `${targetKind} targets must be stored under ${requiredRoot} inside the workspace root.`,
    );
  }
}

function assertInsideBoundary(rootPath: string, path: string, label: string): string {
  const resolvedRootPath = resolve(rootPath);
  const resolvedPath = resolve(resolvedRootPath, path || '.');
  const relativePath = relative(resolvedRootPath, resolvedPath);

  if (relativePath === '' || (!relativePath.startsWith('..') && !relativePath.includes(`..${sep}`))) {
    return resolvedPath;
  }

  throw new Error(`Path escapes coding-worker ${label}: ${path}`);
}
