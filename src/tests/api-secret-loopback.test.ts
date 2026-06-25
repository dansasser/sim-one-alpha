import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isLoopbackRequest, apiSecretHeaderName, requireApiSecret } from '../middleware/api-secret.js';
import type { Context } from 'hono';

function mockContext(remoteAddress: string | undefined, headers: Record<string, string> = {}): Context {
  return {
    req: {
      header: (name: string) => headers[name.toLowerCase()],
    },
    env: {
      incoming: remoteAddress ? { socket: { remoteAddress } } : undefined,
    },
    json: (body: unknown, status: number) => ({ body, status }),
  } as unknown as Context;
}

describe('api-secret middleware — loopback bypass', () => {
  it('returns true for 127.0.0.1', () => {
    const ctx = mockContext('127.0.0.1');
    assert.equal(isLoopbackRequest(ctx), true);
  });

  it('returns true for ::1', () => {
    const ctx = mockContext('::1');
    assert.equal(isLoopbackRequest(ctx), true);
  });

  it('returns true for ::ffff:127.0.0.1', () => {
    const ctx = mockContext('::ffff:127.0.0.1');
    assert.equal(isLoopbackRequest(ctx), true);
  });

  it('returns false for non-loopback address', () => {
    const ctx = mockContext('192.168.1.100');
    assert.equal(isLoopbackRequest(ctx), false);
  });

  it('returns false when X-Forwarded-For is present (even from loopback)', () => {
    const ctx = mockContext('127.0.0.1', { 'x-forwarded-for': '10.0.0.1' });
    assert.equal(isLoopbackRequest(ctx), false);
  });

  it('returns false when X-Real-Ip is present (even from loopback)', () => {
    const ctx = mockContext('127.0.0.1', { 'x-real-ip': '10.0.0.1' });
    assert.equal(isLoopbackRequest(ctx), false);
  });

  it('returns false when Forwarded header is present (even from loopback)', () => {
    const ctx = mockContext('127.0.0.1', { 'forwarded': 'for=10.0.0.1' });
    assert.equal(isLoopbackRequest(ctx), false);
  });

  it('returns false when remoteAddress is missing', () => {
    const ctx = mockContext(undefined);
    assert.equal(isLoopbackRequest(ctx), false);
  });
});

describe('api-secret middleware — requireApiSecret', () => {
  async function callMiddleware(remoteAddress: string | undefined, headers: Record<string, string> = {}, env: Record<string, unknown> = {}): Promise<{ body: unknown; status: number } | undefined> {
    const ctx = mockContext(remoteAddress, headers);
    (ctx as any).env = { ...ctx.env, ...env };
    let nextCalled = false;
    const result = await requireApiSecret(ctx, async () => { nextCalled = true; });
    if (nextCalled) return undefined;
    return result as { body: unknown; status: number };
  }

  it('bypasses auth for loopback requests with no token', async () => {
    const result = await callMiddleware('127.0.0.1');
    assert.equal(result, undefined, 'loopback should pass through');
  });

  it('bypasses auth for ::1 with no token', async () => {
    const result = await callMiddleware('::1');
    assert.equal(result, undefined);
  });

  it('rejects loopback with X-Forwarded-For and no token (API_SECRET not configured)', async () => {
    const result = await callMiddleware('127.0.0.1', { 'x-forwarded-for': '10.0.0.1' }, { API_SECRET: undefined });
    assert.equal(result?.status, 503);
  });

  it('rejects loopback with X-Forwarded-For and wrong token', async () => {
    const result = await callMiddleware('127.0.0.1', { 'x-forwarded-for': '10.0.0.1', 'x-api-secret': 'wrong' }, { API_SECRET: 'test-secret' });
    assert.equal(result?.status, 401);
  });

  it('accepts non-loopback with correct token', async () => {
    const result = await callMiddleware('10.0.0.1', { 'x-api-secret': 'test-secret' }, { API_SECRET: 'test-secret' });
    assert.equal(result, undefined);
  });

  it('rejects non-loopback with wrong token', async () => {
    const result = await callMiddleware('10.0.0.1', { 'x-api-secret': 'wrong' }, { API_SECRET: 'test-secret' });
    assert.equal(result?.status, 401);
  });

  it('returns 503 for non-loopback when API_SECRET not configured', async () => {
    const result = await callMiddleware('10.0.0.1', {}, { API_SECRET: undefined });
    assert.equal(result?.status, 503);
  });

  it('rejects non-loopback with no token header', async () => {
    const result = await callMiddleware('10.0.0.1', {}, { API_SECRET: 'test-secret' });
    assert.equal(result?.status, 401);
  });
});