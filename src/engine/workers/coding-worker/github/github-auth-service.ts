import { execFile } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type {
  GithubAuthProfileRef,
  GithubAuthResult,
  GithubCredentialSource,
} from './github-auth-types.js';

const execFileAsync = promisify(execFile);
const profilePattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface GithubAuthCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type GithubAuthCommandRunner = (
  args: string[],
  env: NodeJS.ProcessEnv,
) => Promise<GithubAuthCommandResult>;

export interface CreateGithubAuthServiceOptions {
  workspaceRoot: string;
  authRoot?: string;
  env?: Record<string, string | undefined>;
  runner?: GithubAuthCommandRunner;
}

export interface GithubAuthService {
  status(input?: GithubAuthProfileRef): Promise<GithubAuthResult>;
  createGhEnv(profile?: string): Promise<NodeJS.ProcessEnv>;
  createGitCredentialEnv(profile?: string): Promise<NodeJS.ProcessEnv>;
}

export async function createGithubAuthService(
  options: CreateGithubAuthServiceOptions,
): Promise<GithubAuthService> {
  const authRoot = resolve(options.authRoot ?? resolve(homedir(), '.gorombo', 'auth', 'github'));
  const workspaceRoot = resolve(options.workspaceRoot);
  await assertAuthRootOutsideWorkspace(authRoot, workspaceRoot);
  await mkdir(authRoot, { recursive: true, mode: 0o700 });
  const runner = options.runner ?? runGh;
  return new DefaultGithubAuthService(authRoot, options.env ?? {}, runner);
}

class DefaultGithubAuthService implements GithubAuthService {
  constructor(
    private readonly authRoot: string,
    private readonly configuredEnv: Record<string, string | undefined>,
    private readonly runner: GithubAuthCommandRunner,
  ) {}

  async status(input: GithubAuthProfileRef = {}): Promise<GithubAuthResult> {
    const profile = normalizeProfile(input.profile);
    const credentialSource = resolveCredentialSource(this.configuredEnv);
    const env = await this.createGhEnv(profile);
    const command = await this.runner(['auth', 'status', '--active', '--hostname', 'github.com'], env);
    const checkedAt = new Date().toISOString();

    if (command.exitCode !== 0) {
      return {
        state: credentialSource === 'none' ? 'unauthenticated' : 'invalid',
        profile,
        hostname: 'github.com',
        credentialSource,
        checkedAt,
        ...(credentialSource === 'none' ? {} : { failureCode: 'github_auth_status_failed' }),
      };
    }

    return {
      state: 'authenticated',
      profile,
      hostname: 'github.com',
      credentialSource: credentialSource === 'none' ? 'managed_profile' : credentialSource,
      checkedAt,
    };
  }

  async createGhEnv(profileInput?: string): Promise<NodeJS.ProcessEnv> {
    const profile = normalizeProfile(profileInput);
    const ghConfigDir = await this.ensureProfileDirectory(profile);
    const env: NodeJS.ProcessEnv = {
      ...baseCommandEnv(),
      GH_CONFIG_DIR: ghConfigDir,
    };
    const source = resolveCredentialSource(this.configuredEnv);
    if (source === 'gh_token') {
      env.GH_TOKEN = this.configuredEnv.GH_TOKEN;
    } else if (source === 'github_token') {
      env.GITHUB_TOKEN = this.configuredEnv.GITHUB_TOKEN;
    }
    return env;
  }

  async createGitCredentialEnv(profileInput?: string): Promise<NodeJS.ProcessEnv> {
    const env = await this.createGhEnv(profileInput);
    return {
      ...env,
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_1: '!gh auth git-credential',
    };
  }

  private async ensureProfileDirectory(profile: string): Promise<string> {
    const profileDirectory = resolve(this.authRoot, 'profiles', profile);
    const ghConfigDir = resolve(profileDirectory, 'gh');
    assertPathInside(ghConfigDir, this.authRoot, 'GitHub profile directory');
    await mkdir(ghConfigDir, { recursive: true, mode: 0o700 });
    return ghConfigDir;
  }
}

function normalizeProfile(value: string | undefined): string {
  const profile = value ?? 'default';
  if (!profilePattern.test(profile)) {
    throw new Error(`Invalid GitHub auth profile: ${profile}`);
  }
  return profile;
}

function resolveCredentialSource(env: Record<string, string | undefined>): GithubCredentialSource {
  if (env.GH_TOKEN?.trim()) return 'gh_token';
  if (env.GITHUB_TOKEN?.trim()) return 'github_token';
  return 'none';
}

function baseCommandEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'SystemRoot', 'ComSpec'] as const) {
    const value = process.env[key];
    if (typeof value === 'string' && value.length > 0) {
      env[key] = value;
    }
  }
  return env;
}

async function assertAuthRootOutsideWorkspace(authRoot: string, workspaceRoot: string): Promise<void> {
  const resolvedAuthRoot = await realpath(authRoot).catch(() => authRoot);
  const resolvedWorkspace = await realpath(workspaceRoot).catch(() => workspaceRoot);
  if (pathsEqual(resolvedAuthRoot, resolvedWorkspace) || isPathInside(resolvedAuthRoot, resolvedWorkspace)) {
    throw new Error('GitHub auth root must be outside the coding-worker workspace root.');
  }
}

function assertPathInside(candidate: string, root: string, label: string): void {
  if (!isPathInside(candidate, root) && !pathsEqual(candidate, root)) {
    throw new Error(`${label} must remain under the managed GitHub auth root.`);
  }
}

function isPathInside(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === 'win32' || process.platform === 'darwin'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

async function runGh(args: string[], env: NodeJS.ProcessEnv): Promise<GithubAuthCommandResult> {
  try {
    const result = await execFileAsync('gh', args, { env, windowsHide: true, timeout: 30_000 });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      exitCode: typeof failure.code === 'number' ? failure.code : 1,
      stdout: typeof failure.stdout === 'string' ? failure.stdout : '',
      stderr: typeof failure.stderr === 'string' ? failure.stderr : '',
    };
  }
}
