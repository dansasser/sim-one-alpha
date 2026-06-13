import type { SessionEnv, ShellResult } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import { execFile } from 'node:child_process';
import { relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  assertInsideCodingScope,
  assertInsideWorkspaceRoot,
  normalizeAgentRelativePath,
  resolveCodingWorkspaceTarget,
  type CodingWorkspaceTargetInput,
  type ResolvedCodingWorkspaceTarget,
} from '../repo/workspace-target.js';
import type { CodingWorkspaceTargetKind } from '../types.js';

const execFileAsync = promisify(execFile);

export interface CodingSandboxRuntime {
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
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean }>;
  exec(command: string, options?: CodingShellOptions): Promise<ShellResult>;
  execFile(file: string, args: string[], options?: CodingShellOptions): Promise<ShellResult>;
  resolveScopePath(path: string): string;
  resolveRepoPath(path: string): string;
  resolveWorkspacePath(path: string): string;
  mkdirWorkspace(path: string, options?: { recursive?: boolean }): Promise<void>;
  writeWorkspaceFile(path: string, content: string): Promise<void>;
}

export interface CodingShellOptions {
  cwd?: string;
  timeoutSeconds?: number;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export interface CodingSandboxOptions extends CodingWorkspaceTargetInput {
  env?: Record<string, string | undefined>;
  sessionId?: string;
}

export async function createFlueLocalCodingSandbox({
  env,
  sessionId = 'coding-worker-local',
  ...targetInput
}: CodingSandboxOptions): Promise<CodingSandboxRuntime> {
  const target = resolveCodingWorkspaceTarget(targetInput);
  const sessionEnv = await local({ cwd: target.workspaceRoot, env }).createSessionEnv({ id: sessionId });
  return new FlueLocalCodingSandboxRuntime(target, sessionEnv, env);
}

class FlueLocalCodingSandboxRuntime implements CodingSandboxRuntime {
  constructor(
    private readonly target: ResolvedCodingWorkspaceTarget,
    private readonly sessionEnv: SessionEnv,
    private readonly env?: Record<string, string | undefined>,
  ) {}

  get workspaceRoot(): string {
    return this.target.workspaceRoot;
  }

  get targetKind(): CodingWorkspaceTargetKind {
    return this.target.targetKind;
  }

  get projectId(): string | undefined {
    return this.target.projectId;
  }

  get projectSlug(): string | undefined {
    return this.target.projectSlug;
  }

  get projectRelativePath(): string {
    return this.target.projectRelativePath;
  }

  get scopePath(): string {
    return this.target.scopePath;
  }

  get repoPath(): string {
    return this.target.repoPath;
  }

  async readFile(path: string): Promise<string> {
    return this.sessionEnv.readFile(this.resolveScopePath(path));
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.sessionEnv.writeFile(this.resolveScopePath(path), content);
  }

  async readdir(path: string): Promise<string[]> {
    return this.sessionEnv.readdir(this.resolveScopePath(path));
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await this.sessionEnv.mkdir(this.resolveScopePath(path), options);
  }

  async exists(path: string): Promise<boolean> {
    return this.sessionEnv.exists(this.resolveScopePath(path));
  }

  async stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean }> {
    const stat = await this.sessionEnv.stat(this.resolveScopePath(path));
    return {
      isFile: stat.isFile,
      isDirectory: stat.isDirectory,
    };
  }

  async exec(command: string, options: CodingShellOptions = {}): Promise<ShellResult> {
    return this.sessionEnv.exec(command, {
      cwd: options.cwd ? this.resolveScopePath(options.cwd) : this.scopePath,
      env: options.env,
      timeout: options.timeoutSeconds,
      signal: options.signal,
    });
  }

  async execFile(file: string, args: string[], options: CodingShellOptions = {}): Promise<ShellResult> {
    try {
      const result = await execFileAsync(file, args, {
        cwd: options.cwd ? this.resolveScopePath(options.cwd) : this.scopePath,
        env: mergeEnv(this.env, options.env),
        windowsHide: true,
        timeout: options.timeoutSeconds ? options.timeoutSeconds * 1_000 : undefined,
        signal: options.signal,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: 0,
      };
    } catch (error) {
      if (isExecFileError(error)) {
        return {
          stdout: typeof error.stdout === 'string' ? error.stdout : '',
          stderr: typeof error.stderr === 'string' ? error.stderr : String(error.message ?? ''),
          exitCode: typeof error.code === 'number' ? error.code : 1,
        };
      }
      throw error;
    }
  }

  resolveScopePath(path: string): string {
    return assertInsideCodingScope(this.scopePath, path);
  }

  resolveRepoPath(path: string): string {
    return this.resolveScopePath(path);
  }

  resolveWorkspacePath(path: string): string {
    return assertInsideWorkspaceRoot(this.workspaceRoot, path);
  }

  async mkdirWorkspace(path: string, options?: { recursive?: boolean }): Promise<void> {
    await this.sessionEnv.mkdir(this.resolveWorkspacePath(path), options);
  }

  async writeWorkspaceFile(path: string, content: string): Promise<void> {
    await this.sessionEnv.writeFile(this.resolveWorkspacePath(path), content);
  }
}

function mergeEnv(
  base: Record<string, string | undefined> | undefined,
  override: Record<string, string> | undefined,
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(base ?? {})) {
    if (value === undefined) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }
  for (const [key, value] of Object.entries(override ?? {})) {
    merged[key] = value;
  }
  return merged;
}

function isExecFileError(error: unknown): error is Error & {
  code?: number | string;
  stdout?: string;
  stderr?: string;
} {
  return Boolean(error && typeof error === 'object' && 'code' in error);
}

export function assertInsideRepo(repoPath: string, path: string): string {
  return assertInsideCodingScope(repoPath, path);
}

export function normalizeRepoRelativePath(repoPath: string, path: string): string {
  const resolvedPath = assertInsideRepo(repoPath, path);
  const relativePath = relative(resolve(repoPath), resolvedPath);
  return normalizeAgentRelativePath(relativePath || '.');
}
