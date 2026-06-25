import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ServerManagerOptions {
  port?: number;
  serverPath?: string;
  envPath?: string;
}

export interface ServerManagerResult {
  started: boolean;
  pid?: number;
  port: number;
  baseUrl: string;
}

const HEALTH_POLL_INTERVAL_MS = 2000;
const HEALTH_TIMEOUT_MS = 120_000;

export async function ensureServerRunning(options: ServerManagerOptions = {}): Promise<ServerManagerResult> {
  const port = options.port ?? readGatewayPort() ?? 3000;
  const baseUrl = `http://127.0.0.1:${port}`;

  const healthOk = await checkHealth(baseUrl);
  if (healthOk) {
    return { started: false, port, baseUrl };
  }

  const serverPath = options.serverPath ?? resolveServerPath();
  if (!existsSync(serverPath)) {
    console.error(`Agent package not found at ${serverPath}. Run 'sim-one install' first.`);
    process.exit(1);
  }

  const envPath = options.envPath ?? resolveEnvPath();
  const child = startServer(serverPath, envPath, port);
  serverChild = child;

  await waitForHealth(baseUrl, child);

  (child as any).__detachLogs?.();

  return { started: true, pid: child.pid ?? undefined, port, baseUrl };
}

export async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  child.kill('SIGTERM');
  const exited = await waitForExit(child, 5000);
  if (exited) return;

  child.kill('SIGKILL');
  await waitForExit(child, 5000);
}

let serverChild: ChildProcess | undefined;

export function setServerChild(child: ChildProcess): void {
  serverChild = child;
}

export async function cleanupServer(): Promise<void> {
  if (serverChild) {
    await stopServer(serverChild);
    serverChild = undefined;
  }
}

function resolveServerPath(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));

  if (process.env.SIM_ONE_SERVER_PATH) {
    return resolve(process.env.SIM_ONE_SERVER_PATH);
  }

  const siblingCandidate = resolve(moduleDir, '..', 'sim-one-alpha', 'server.mjs');
  if (existsSync(siblingCandidate)) {
    return siblingCandidate;
  }

  const devCandidate = resolve(process.cwd(), '.gorombo', 'sim-one-alpha', 'server.mjs');
  if (existsSync(devCandidate)) {
    return devCandidate;
  }

  return siblingCandidate;
}

function resolveEnvPath(): string {
  if (process.env.SIM_ONE_ENV_PATH) {
    return resolve(process.env.SIM_ONE_ENV_PATH);
  }

  const prodEnv = resolve(homedir(), '.gorombo', '.env');
  if (existsSync(prodEnv)) {
    return prodEnv;
  }

  return resolve(process.cwd(), '.env');
}

function readGatewayPort(): number | undefined {
  const moduleDir = dirname(fileURLToPath(import.meta.url));

  const candidates = [
    resolve(moduleDir, '..', 'sim-one-alpha', 'gorombo.config.json'),
    resolve(process.cwd(), '.gorombo', 'sim-one-alpha', 'gorombo.config.json'),
    resolve(process.cwd(), 'src', 'config', 'gorombo.config.json'),
  ];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const config = JSON.parse(readFileSync(candidate, 'utf8'));
      if (typeof config.gateway?.port === 'number') {
        return config.gateway.port;
      }
    } catch {
    }
  }

  return undefined;
}

function startServer(serverPath: string, envPath: string, port: number): ChildProcess {
  const args = existsSync(envPath)
    ? ['--env-file=' + envPath, serverPath]
    : [serverPath];

  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.on('error', (err) => {
    console.error(`Failed to start server: ${err.message}`);
  });

  const stdoutListener = (chunk: Buffer) => { process.stdout.write(chunk); };
  const stderrListener = (chunk: Buffer) => { process.stderr.write(chunk); };
  child.stdout?.on('data', stdoutListener);
  child.stderr?.on('data', stderrListener);

  (child as any).__detachLogs = () => {
    child.stdout?.off('data', stdoutListener);
    child.stderr?.off('data', stderrListener);
  };

  return child;
}

async function checkHealth(baseUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(`${baseUrl}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    return resp.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(baseUrl: string, child?: ChildProcess): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(`Server exited unexpectedly with code ${child.exitCode} before becoming healthy.`);
    }
    if (await checkHealth(baseUrl)) return;
    await sleep(HEALTH_POLL_INTERVAL_MS);
  }

  throw new Error(`Server did not become healthy within ${HEALTH_TIMEOUT_MS / 1000}s. Check the server output above.`);
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}