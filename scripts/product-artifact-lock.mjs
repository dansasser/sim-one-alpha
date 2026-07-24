import { resolve } from 'node:path';
import { lock } from 'proper-lockfile';

const RETRY_MS = 100;
const STALE_AFTER_MS = 30 * 60 * 1000;
const WAIT_TIMEOUT_MS = STALE_AFTER_MS + 5 * 60 * 1000;

export async function acquireProductArtifactLock(options = {}) {
  const lockPath = resolve(options.lockPath ?? '.gorombo/.product-artifact-test.lock');
  const retryMs = options.retryMs ?? RETRY_MS;
  const staleAfterMs = options.staleAfterMs ?? STALE_AFTER_MS;
  const waitTimeoutMs = options.waitTimeoutMs ?? WAIT_TIMEOUT_MS;
  const deadline = Date.now() + waitTimeoutMs;

  while (true) {
    try {
      return await lock(lockPath, {
        lockfilePath: lockPath,
        realpath: false,
        retries: 0,
        stale: staleAfterMs,
        update: Math.floor(staleAfterMs / 2),
      });
    } catch (error) {
      if (error?.code !== 'ELOCKED') {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for product artifact lock ${lockPath}.`);
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, retryMs));
    }
  }
}
