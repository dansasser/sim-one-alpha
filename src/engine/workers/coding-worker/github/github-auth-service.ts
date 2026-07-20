import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type {
  GithubAuthProfileRef,
  GithubAuthResult,
  GithubCredentialSource,
  GithubAuthCancelInput,
  GithubAuthChallenge,
  GithubAuthStartInput,
} from './github-auth-types.js';
import { sameGithubAuthAudience } from './github-auth-utils.js';

const execFileAsync = promisify(execFile);
const profilePattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface GithubAuthCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  failureKind?: 'not_found' | 'timeout' | 'execution';
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
  sessionTtlMs?: number;
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
  await assertAuthRootOutsideWorkspace(authRoot, workspaceRoot);
  await chmod(authRoot, 0o700);
  const runner = options.runner ?? runGh;
  return new DefaultGithubAuthService(
    authRoot,
    options.env ?? {},
    runner,
    options.loginRunner ?? ghLoginRunner,
    options.sessionTtlMs ?? 15 * 60_000,
  );
}

class DefaultGithubAuthService implements GithubAuthService {
  constructor(
    private readonly authRoot: string,
    private readonly configuredEnv: Record<string, string | undefined>,
    private readonly runner: GithubAuthCommandRunner,
    private readonly loginRunner: GithubAuthLoginRunner,
    private readonly sessionTtlMs: number,
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

    for (const session of this.#sessions.values()) {
      this.expireSessionIfNeeded(session);
    }
    const existing = [...this.#sessions.values()].find((session) => session.profile === profile && isActiveState(session.state));
    if (existing) {
      if (!sameGithubAuthAudience(existing.audience, input.audience)) {
        throw new Error('GitHub auth profile already has an active session for another audience.');
      }
      return toResult(existing, checkedAt);
    }

    const session: AuthSession = {
      id: input.authSessionId ?? randomUUID(),
      profile,
      state: 'authorization_pending',
      expiresAt: new Date(Date.now() + this.sessionTtlMs).toISOString(),
      checkedAt,
      credentialSource: 'managed_profile',
      audience: input.audience,
    };
    this.#sessions.set(session.id, session);
    this.scheduleExpiry(session);
    try {
      const env = await this.createGhEnv(profile);
      if (!this.isCurrentActiveSession(session)) {
        return toResult(session, new Date().toISOString());
      }
      let output = '';
      let promptOutput = '';
      let resolveChallenge: ((challenge: GithubAuthChallenge) => void) | undefined;
      const challengePromise = new Promise<GithubAuthChallenge>((resolveChallengePromise) => {
        resolveChallenge = resolveChallengePromise;
      });
      let loginProcess: GithubAuthLoginProcess | undefined;
      let shouldSubmitEnter = false;
      let submittedEnter = false;
      const submitEnter = () => {
        if (!shouldSubmitEnter || submittedEnter || !loginProcess?.submitInput) return;
        loginProcess.submitInput('\n');
        submittedEnter = true;
      };
      loginProcess = await this.loginRunner.start(loginArgs, env, (chunk) => {
        if (!this.isCurrentActiveSession(session)) return;
        promptOutput = `${promptOutput}${chunk}`.slice(-256);
        if (/press\s+enter/i.test(promptOutput)) {
          shouldSubmitEnter = true;
        }
        if (resolveChallenge) {
          output += chunk;
          const parsed = parseDeviceChallenge(output, session);
          if (parsed) {
            resolveChallenge(parsed);
            resolveChallenge = undefined;
            output = '';
          }
        }
        submitEnter();
      });
      if (!this.isCurrentActiveSession(session)) {
        loginProcess.cancel();
        return toResult(session, new Date().toISOString());
      }
      session.process = loginProcess;
      submitEnter();
      const challenge = await withTimeout(challengePromise, 15_000, 'GitHub device challenge was not available.');
      if (!this.isCurrentActiveSession(session)) {
        loginProcess.cancel();
        return toResult(session, new Date().toISOString());
      }
      await input.deliverChallenge(challenge);
      if (!this.isCurrentActiveSession(session)) {
        loginProcess.cancel();
        return toResult(session, new Date().toISOString());
      }
      this.observeCompletion(session);
      return toResult(session, new Date().toISOString());
    } catch (error) {
      if (!this.isCurrentActiveSession(session)) {
        return toResult(session, new Date().toISOString());
      }
      const result = this.finishSession(session, 'failed', 'github_device_login_failed', true);
      return result;
    }
  }

  async cancel(input: GithubAuthCancelInput): Promise<GithubAuthResult> {
    assertAudience(input.audience);
    const session = this.#sessions.get(input.authSessionId);
    if (!session) {
      throw new Error('GitHub auth session was not found.');
    }
    if (!sameGithubAuthAudience(session.audience, input.audience)) {
      throw new Error('GitHub auth session audience does not match the initiating audience.');
    }
    return this.finishSession(session, 'cancelled', undefined, true);
  }

  async status(input: GithubAuthProfileRef = {}): Promise<GithubAuthResult> {
    const profile = normalizeProfile(input.profile);
    const activeSession = [...this.#sessions.values()].find((session) => session.profile === profile && isActiveState(session.state));
    if (activeSession) {
      this.expireSessionIfNeeded(activeSession);
      return toResult(activeSession, new Date().toISOString());
    }
    return this.verifyProfile(profile);
  }

  private async verifyProfile(profile: string): Promise<GithubAuthResult> {
    const credentialSource = resolveCredentialSource(this.configuredEnv);
    const env = await this.createGhEnv(profile);
    const command = await this.runner(['auth', 'status', '--active', '--hostname', 'github.com'], env);
    const checkedAt = new Date().toISOString();

    if (command.exitCode !== 0) {
      if (credentialSource === 'none' && isExplicitLoggedOutResult(command)) {
        return {
          state: 'unauthenticated',
          profile,
          hostname: 'github.com',
          credentialSource,
          checkedAt,
        };
      }
      return {
        state: credentialSource === 'none' ? 'unknown' : 'invalid',
        profile,
        hostname: 'github.com',
        credentialSource,
        checkedAt,
        failureCode: command.failureKind
          ? `github_auth_${command.failureKind}`
          : 'github_auth_status_failed',
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
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_1: '',
      GIT_CONFIG_KEY_2: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_2: '!gh auth git-credential',
    };
  }

  private async ensureProfileDirectory(profile: string): Promise<string> {
    const profileDirectory = resolve(this.authRoot, 'profiles', profile);
    const ghConfigDir = resolve(profileDirectory, 'gh');
    assertPathInside(ghConfigDir, this.authRoot, 'GitHub profile directory');
    const directories = [resolve(this.authRoot, 'profiles'), profileDirectory, ghConfigDir];
    for (const directory of directories) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
    }
    return ghConfigDir;
  }

  private observeCompletion(session: AuthSession): void {
    const process = session.process;
    if (!process) return;
    void process.completion.then(async (result) => {
      if (session.state !== 'authorization_pending') return;
      if (result.exitCode !== 0) {
        this.finishSession(session, 'failed', 'github_device_login_failed');
        return;
      }
      session.state = 'verifying';
      const verified = await this.verifyProfile(session.profile);
      this.finishSession(session, verified.state, verified.failureCode);
    }).catch(() => {
      if (isActiveState(session.state)) {
        this.finishSession(session, 'failed', 'github_device_login_failed');
      }
    });
  }

  private scheduleExpiry(session: AuthSession): void {
    const expiresAt = Date.parse(session.expiresAt);
    const delay = Math.min(Math.max(0, expiresAt - Date.now()), 2_147_483_647);
    session.expiryTimer = setTimeout(() => {
      if (this.#sessions.get(session.id) !== session) return;
      if (Date.parse(session.expiresAt) > Date.now()) {
        this.scheduleExpiry(session);
        return;
      }
      this.finishSession(session, 'expired', undefined, true);
    }, delay);
    session.expiryTimer.unref?.();
  }

  private expireSessionIfNeeded(session: AuthSession): boolean {
    if (!isActiveState(session.state) || Date.parse(session.expiresAt) > Date.now()) return false;
    this.finishSession(session, 'expired', undefined, true);
    return true;
  }

  private isCurrentActiveSession(session: AuthSession): boolean {
    return this.#sessions.get(session.id) === session && isActiveState(session.state);
  }

  private finishSession(
    session: AuthSession,
    state: GithubAuthResult['state'],
    failureCode?: string,
    cancelProcess = false,
  ): GithubAuthResult {
    session.state = state;
    session.failureCode = failureCode;
    if (session.expiryTimer) clearTimeout(session.expiryTimer);
    session.expiryTimer = undefined;
    if (cancelProcess) session.process?.cancel();
    session.process = undefined;
    if (this.#sessions.get(session.id) === session) {
      this.#sessions.delete(session.id);
    }
    return toResult(session, new Date().toISOString());
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
  expiryTimer?: NodeJS.Timeout;
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
  for (const key of ['connector', 'actorId', 'conversationId', 'eventId'] as const) {
    const value = audience?.[key];
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`GitHub auth audience requires ${key}.`);
    }
  }
}

function isExplicitLoggedOutResult(command: GithubAuthCommandResult): boolean {
  if (command.failureKind) return false;
  return /not logged (?:in|into)|not authenticated|no (?:github )?accounts?/i.test(
    `${command.stdout}\n${command.stderr}`,
  );
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
  const resolvedAuthRoot = await resolveThroughExistingParent(authRoot);
  const resolvedWorkspace = await resolveThroughExistingParent(workspaceRoot);
  if (pathsEqual(resolvedAuthRoot, resolvedWorkspace) || isPathInside(resolvedAuthRoot, resolvedWorkspace)) {
    throw new Error('GitHub auth root must be outside the coding-worker workspace root.');
  }
}

async function resolveThroughExistingParent(path: string): Promise<string> {
  let current = resolve(path);
  const missingSegments: string[] = [];
  while (true) {
    try {
      return resolve(await realpath(current), ...missingSegments);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missingSegments.unshift(basename(current));
      current = parent;
    }
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
    const failure = error as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
    };
    const failureKind = failure.code === 'ENOENT'
      ? 'not_found'
      : failure.killed || failure.code === 'ETIMEDOUT'
        ? 'timeout'
        : typeof failure.code === 'number'
          ? undefined
          : 'execution';
    return {
      exitCode: typeof failure.code === 'number' ? failure.code : 1,
      stdout: typeof failure.stdout === 'string' ? failure.stdout : '',
      stderr: typeof failure.stderr === 'string' ? failure.stderr : '',
      ...(failureKind ? { failureKind } : {}),
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
