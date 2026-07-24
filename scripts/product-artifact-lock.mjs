import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const RETRY_MS = 100;
const WAIT_TIMEOUT_MS = 15 * 60 * 1000;
const STALE_AFTER_MS = 30 * 60 * 1000;

export async function acquireProductArtifactLock() {
  const lockPath = resolve('.gorombo', '.product-artifact-test.lock');
  const deadline = Date.now() + WAIT_TIMEOUT_MS;

  while (true) {
    try {
      mkdirSync(lockPath, { recursive: false });
      writeFileSync(
        join(lockPath, 'owner.json'),
        `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
      );
      return () => rmSync(lockPath, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > STALE_AFTER_MS) {
          rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if (statError?.code !== 'ENOENT') {
          throw statError;
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for product artifact lock ${lockPath}.`);
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, RETRY_MS));
    }
  }
}
