import type { CodingSandboxRuntime } from './sandbox-runtime.js';

export type GithubRemoteOperation = 'fetch' | 'push';

export async function githubCredentialOptions(
  sandbox: CodingSandboxRuntime,
  remote: string,
  githubGitEnv: (() => Promise<Record<string, string>>) | undefined,
  operation: GithubRemoteOperation = 'fetch',
): Promise<{ env?: Record<string, string> }> {
  const args = [
    'remote',
    'get-url',
    ...(operation === 'push' ? ['--push'] : []),
    '--all',
    remote,
  ];
  const remoteUrls = await sandbox.execFile('git', args, { timeoutSeconds: 30 });
  const urls = remoteUrls.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  if (urls.some(hasEmbeddedUrlCredentials)) {
    throw new Error('Git remote URLs with embedded credentials are not allowed.');
  }
  if (remoteUrls.exitCode !== 0 || urls.length === 0 || !urls.every(isManagedGithubHttpsRemote) || !githubGitEnv) {
    return { env: createNoCredentialGitEnv() };
  }
  return { env: { ...createNoCredentialGitEnv(), ...await githubGitEnv() } };
}

export async function githubUrlCredentialOptions(
  remoteUrl: string,
  githubGitEnv: (() => Promise<Record<string, string>>) | undefined,
): Promise<{ env: Record<string, string> }> {
  if (hasEmbeddedUrlCredentials(remoteUrl)) {
    throw new Error('Git remote URLs with embedded credentials are not allowed.');
  }
  if (!githubGitEnv || !isManagedGithubHttpsRemote(remoteUrl)) {
    return { env: createNoCredentialGitEnv() };
  }
  return { env: { ...createNoCredentialGitEnv(), ...await githubGitEnv() } };
}

export function isManagedGithubHttpsRemote(remoteUrl: string): boolean {
  try {
    const parsed = new URL(remoteUrl);
    return parsed.protocol === 'https:' &&
      parsed.hostname === 'github.com' &&
      (parsed.port === '' || parsed.port === '443') &&
      !parsed.username &&
      !parsed.password;
  } catch {
    return false;
  }
}

function hasEmbeddedUrlCredentials(remoteUrl: string): boolean {
  try {
    const parsed = new URL(remoteUrl);
    return Boolean(parsed.username || parsed.password);
  } catch {
    return false;
  }
}

function createNoCredentialGitEnv(): Record<string, string> {
  return {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_TERMINAL_PROMPT: '0',
  };
}
