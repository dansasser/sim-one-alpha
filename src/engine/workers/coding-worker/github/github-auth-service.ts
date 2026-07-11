import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type {
  GithubAuthProfileRef,
  GithubAuthResult,
  GithubCredentialSource,
  GithubAuthCancelInput,
  GithubAuthChallenge,
  GithubAuthStartInput,
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

export interface GithubAuthLoginProcess {
  completion: Promise<GithubAuthCommandResult>;
  cancel(): void;
  submitInput?(value: string): void;
}

export interface GithubAuthLoginRunner {
  start(
    args: string[],
    env: NodeJS.ProcessEnv,
    onOutput: (value: string) => void,
  ): Promise<GithubAuthLoginProcess>;
}

export interface CreateGithubAuthServiceOptions {
  workspaceRoot: string;
  authRoot?: string;
  env?: Record<string, string | undefined>;
  runner?: GithubAuthCommandRunner;
  loginRunner?: GithubAuthLoginRunner;
}

export interface GithubAuthService {
  status(input?: GithubAuthProfileRef): Promise<GithubAuthResult>;
  start(input: GithubAuthStartInput): Promise<GithubAuthResult>;
  cancel(input: GithubAuthCancelInput): Promise<GithubAuthResult>;
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
  return new DefaultGithubAuthService(authRoot, options.env ?? {}, runner, options.loginRunner ?? ghLoginRunner);
}

class DefaultGithubAuthService implements GithubAuthService {
  constructor(
    private readonly authRoot: string,
    private readonly configuredEnv: Record<string, string | undefined>,
    private readonly runner: GithubAuthCommandRunner,
    private readonly loginRunner: GithubAuthLoginRunner,
  ) {}

  readonly #sessions = new Map<string, AuthSession>();

  async start(input: GithubAuthStartInput): Promise<GithubAuthResult> {
    const profile = normalizeProfile(input.profile);
    assertAudience(input.audience);
    const explicitSource = resolveCredentialSource(this.configuredEnv);
    const checkedAt = new Date().toISOString();
    if (explicitSource !== 'none') {
      return {
        state: 'invalid',
        profile,
        hostname: 'github.com',
        credentialSource: explicitSource,
        checkedAt,
        failureCode: 'explicit_credential_selected',
      };
    }

    const existing = [...this.#sessions.values()].find((session) => session.profile === profile && isActiveState(session.state));
    if (existing) {
      return toResult(existing, checkedAt);
    }

    const session: AuthSession = {
      id: input.authSessionId ?? randomUUID(),
      profile,
      state: 'authorization_pending',
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      checkedAt,
      credentialSource: 'managed_profile',
      audience: input.audience,
    };
    this.#sessions.set(session.id, session);
    const env = await this.createGhEnv(profile);
    let output = '';
    let resolveChallenge: ((challenge: GithubAuthChallenge) => void) | undefined;
    let rejectChallenge: ((error: Error) => void) | undefined;
    const challengePromise = new Promise<GithubAuthChallenge>((resolveChallengePromise, rejectChallengePromise) => {
      resolveChallenge = resolveChallengePromise;
      rejectChallenge = rejectChallengePromise;
    });

    try {
      let loginProcess: GithubAuthLoginProcess | undefined;
      let shouldSubmitEnter = false;
      let submittedEnter = false;
      const submitEnter = () => {
        if (!shouldSubmitEnter || submittedEnter || !loginProcess?.submitInput) return;
        loginProcess.submitInput('\n');
        submittedEnter = true;
      };
      loginProcess = await this.loginRunner.start(loginArgs, env, (chunk) => {
        output += chunk;
        const parsed = parseDeviceChallenge(output, session);
        if (parsed && resolveChallenge) {
          resolveChallenge(parsed);
          resolveChallenge = undefined;
          if (/press\s+enter/i.test(output)) {
            shouldSubmitEnter = true;
            submitEnter();
          }
        }
      });
      session.process = loginProcess;
      submitEnter();
      const challenge = await withTimeout(challengePromise, 15_000, 'GitHub device challenge was not available.');
      await input.deliverChallenge(challenge);
      this.observeCompletion(session);
      return toResult(session, new Date().toISOString());
    } catch (error) {
      rejectChallenge?.(toError(error));
      session.state = 'failed';
      session.failureCode = 'github_device_login_failed';
      session.process?.cancel();
      return toResult(session, new Date().toISOString());
    }
  }

  async cancel(input: GithubAuthCancelInput): Promise<GithubAuthResult> {
    const session = this.#sessions.get(input.authSessionId);
    if (!session) {
      throw new Error('GitHub auth session was not found.');
    }
    if (isActiveState(session.state)) {
      session.process?.cancel();
      session.state = 'cancelled';
    }
    return toResult(session, new Date().toISOString());
  }

  async status(input: GithubAuthProfileRef = {}): Promise<GithubAuthResult> {
    const profile = normalizeProfile(input.profile);
    const activeSession = [...this.#sessions.values()].find((session) => session.profile === profile && isActiveState(session.state));
    if (activeSession) {
      if (Date.parse(activeSession.expiresAt) <= Date.now()) {
        activeSession.process?.cancel();
        activeSession.state = 'expired';
      }
      return toResult(activeSession, new Date().toISOString());
    }
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

    const identity = await this.runner(['api', 'user', '--jq', '.login'], env);
    const accountLogin = identity.stdout.trim();
    if (identity.exitCode !== 0 || !accountLogin) {
      return {
        state: 'invalid',
        profile,
        hostname: 'github.com',
        credentialSource: credentialSource === 'none' ? 'managed_profile' : credentialSource,
        checkedAt,
        failureCode: 'github_api_identity_failed',
      };
    }
    const gitProtocol = await this.runner(['config', 'get', 'git_protocol', '--host', 'github.com'], env);
    if (gitProtocol.exitCode !== 0 || gitProtocol.stdout.trim() !== 'https') {
      return {
        state: 'invalid',
        profile,
        hostname: 'github.com',
        credentialSource: credentialSource === 'none' ? 'managed_profile' : credentialSource,
        accountLogin,
        checkedAt,
        failureCode: 'github_https_protocol_not_configured',
      };
    }

    return {
      state: 'authenticated',
      profile,
      hostname: 'github.com',
      credentialSource: credentialSource === 'none' ? 'managed_profile' : credentialSource,
      accountLogin,
      gitProtocol: 'https',
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

  private observeCompletion(session: AuthSession): void {
    const process = session.process;
    if (!process) return;
    void process.completion.then(async (result) => {
      if (session.state !== 'authorization_pending') return;
      if (result.exitCode !== 0) {
        session.state = 'failed';
        session.failureCode = 'github_device_login_failed';
        return;
      }
      session.state = 'verifying';
      const verified = await this.status({ profile: session.profile });
      session.state = verified.state;
      session.failureCode = verified.failureCode;
    }).catch(() => {
      if (session.state === 'authorization_pending') {
        session.state = 'failed';
        session.failureCode = 'github_device_login_failed';
      }
    });
  }
}

interface AuthSession {
  id: string;
  profile: string;
  state: GithubAuthResult['state'];
  credentialSource: GithubCredentialSource;
  expiresAt: string;
  checkedAt: string;
  audience: GithubAuthStartInput['audience'];
  process?: GithubAuthLoginProcess;
  failureCode?: string;
}

const loginArgs = [
  'auth',
  'login',
  '--hostname',
  'github.com',
  '--git-protocol',
  'https',
  '--web',
  '--skip-ssh-key',
  '--scopes',
  'workflow',
];

function toResult(session: AuthSession, checkedAt: string): GithubAuthResult {
  return {
    state: session.state,
    profile: session.profile,
    hostname: 'github.com',
    credentialSource: session.credentialSource,
    authSessionId: session.id,
    expiresAt: session.expiresAt,
    checkedAt,
    ...(session.failureCode ? { failureCode: session.failureCode } : {}),
  };
}

function isActiveState(state: GithubAuthResult['state']): boolean {
  return state === 'authorization_pending' || state === 'verifying';
}

function assertAudience(audience: GithubAuthStartInput['audience']): void {
  for (const [key, value] of Object.entries(audience)) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`GitHub auth audience requires ${key}.`);
    }
  }
}

function parseDeviceChallenge(output: string, session: AuthSession): GithubAuthChallenge | undefined {
  const verificationUri = output.match(/https:\/\/github\.com\/login\/device\b/)?.[0];
  const userCode = output.match(/(?:one-time\s+code|code)\s*:?\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i)?.[1];
  if (verificationUri !== 'https://github.com/login/device' || !userCode) {
    return undefined;
  }
  return {
    sessionId: session.id,
    audience: session.audience,
    verificationUri,
    userCode: userCode.toUpperCase(),
    expiresAt: session.expiresAt,
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
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

const ghLoginRunner: GithubAuthLoginRunner = {
  async start(args, env, onOutput): Promise<GithubAuthLoginProcess> {
    const child = spawn('gh', args, {
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk: Buffer) => onOutput(chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => onOutput(chunk.toString('utf8')));
    const completion = new Promise<GithubAuthCommandResult>((resolveCompletion) => {
      child.once('error', (error) => {
        resolveCompletion({ exitCode: 1, stdout: '', stderr: error.message });
      });
      child.once('close', (code) => {
        resolveCompletion({ exitCode: code ?? 1, stdout: '', stderr: '' });
      });
    });
    return {
      completion,
      cancel: () => {
        if (!child.killed) child.kill();
      },
      submitInput: (value) => {
        if (!child.stdin.destroyed) child.stdin.write(value);
      },
    };
  },
};
