import type { SessionEnv, ShellResult } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import { relative, resolve, sep } from 'node:path';

export interface CodingSandboxRuntime {
  repoPath: string;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean }>;
  exec(command: string, options?: CodingShellOptions): Promise<ShellResult>;
  resolveRepoPath(path: string): string;
}

export interface CodingShellOptions {
  cwd?: string;
  timeoutSeconds?: number;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export interface CodingSandboxOptions {
  repoPath: string;
  env?: Record<string, string | undefined>;
  sessionId?: string;
}

export async function createFlueLocalCodingSandbox({
  repoPath,
  env,
  sessionId = 'coding-worker-local',
}: CodingSandboxOptions): Promise<CodingSandboxRuntime> {
  const resolvedRepoPath = resolve(repoPath);
  const sessionEnv = await local({ cwd: resolvedRepoPath, env }).createSessionEnv({ id: sessionId });
  return new FlueLocalCodingSandboxRuntime(resolvedRepoPath, sessionEnv);
}

class FlueLocalCodingSandboxRuntime implements CodingSandboxRuntime {
  constructor(
    readonly repoPath: string,
    private readonly sessionEnv: SessionEnv,
  ) {}

  async readFile(path: string): Promise<string> {
    return this.sessionEnv.readFile(this.resolveRepoPath(path));
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.sessionEnv.writeFile(this.resolveRepoPath(path), content);
  }

  async readdir(path: string): Promise<string[]> {
    return this.sessionEnv.readdir(this.resolveRepoPath(path));
  }

  async exists(path: string): Promise<boolean> {
    return this.sessionEnv.exists(this.resolveRepoPath(path));
  }

  async stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean }> {
    const stat = await this.sessionEnv.stat(this.resolveRepoPath(path));
    return {
      isFile: stat.isFile,
      isDirectory: stat.isDirectory,
    };
  }

  async exec(command: string, options: CodingShellOptions = {}): Promise<ShellResult> {
    return this.sessionEnv.exec(command, {
      cwd: options.cwd ? this.resolveRepoPath(options.cwd) : this.repoPath,
      env: options.env,
      timeout: options.timeoutSeconds,
      signal: options.signal,
    });
  }

  resolveRepoPath(path: string): string {
    return assertInsideRepo(this.repoPath, path);
  }
}

export function assertInsideRepo(repoPath: string, path: string): string {
  const resolvedRepoPath = resolve(repoPath);
  const resolvedPath = resolve(resolvedRepoPath, path || '.');
  const relativePath = relative(resolvedRepoPath, resolvedPath);

  if (relativePath === '' || (!relativePath.startsWith('..') && !relativePath.includes(`..${sep}`))) {
    return resolvedPath;
  }

  throw new Error(`Path escapes coding-worker repository boundary: ${path}`);
}

export function normalizeRepoRelativePath(repoPath: string, path: string): string {
  const resolvedPath = assertInsideRepo(repoPath, path);
  const relativePath = relative(resolve(repoPath), resolvedPath);
  return relativePath || '.';
}
