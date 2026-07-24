import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acquireProductArtifactLock } from './product-artifact-lock.mjs';

test('waits for the current product artifact owner and then acquires the lock', async () => {
  const fixture = createFixture();
  const releaseFirst = await acquireProductArtifactLock({
    lockPath: fixture.lockPath,
    retryMs: 5,
    waitTimeoutMs: 1000,
  });

  try {
    let secondAcquired = false;
    const second = acquireProductArtifactLock({
      lockPath: fixture.lockPath,
      retryMs: 5,
      waitTimeoutMs: 1000,
    }).then((release) => {
      secondAcquired = true;
      return release;
    });

    await sleep(25);
    assert.equal(secondAcquired, false);
    await releaseFirst();

    const releaseSecond = await second;
    assert.equal(secondAcquired, true);
    await releaseSecond();
  } finally {
    fixture.cleanup();
  }
});

test('reclaims an abandoned stale product artifact lock', async () => {
  const fixture = createFixture();
  mkdirSync(fixture.lockPath);
  const staleTime = new Date(Date.now() - 10_000);
  utimesSync(fixture.lockPath, staleTime, staleTime);

  try {
    const release = await acquireProductArtifactLock({
      lockPath: fixture.lockPath,
      retryMs: 5,
      staleAfterMs: 2000,
      waitTimeoutMs: 1000,
    });

    assert.equal(existsSync(fixture.lockPath), true);
    await release();
    assert.equal(existsSync(fixture.lockPath), false);
  } finally {
    fixture.cleanup();
  }
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'sim-one-product-lock-'));
  return {
    lockPath: join(root, 'artifact.lock'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function sleep(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}
