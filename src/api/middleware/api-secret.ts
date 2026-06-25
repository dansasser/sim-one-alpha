import type { MiddlewareHandler } from 'hono';

export const apiSecretHeaderName = 'x-api-secret';

const loopbackAddresses = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export const requireApiSecret: MiddlewareHandler = async (c, next) => {
  if (isLoopbackRequest(c)) {
    await next();
    return;
  }

  const expectedSecret = readApiSecret(c.env as Record<string, unknown> | undefined);

  if (!expectedSecret) {
    return c.json({ error: 'API secret is not configured' }, 503);
  }

  if (c.req.header(apiSecretHeaderName) !== expectedSecret) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  await next();
};

export function isLoopbackRequest(c: Parameters<MiddlewareHandler>[0]): boolean {
  if (c.req.header('x-forwarded-for')) return false;
  if (c.req.header('x-real-ip')) return false;
  if (c.req.header('forwarded')) return false;

  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  const addr = env?.incoming?.socket?.remoteAddress;
  return typeof addr === 'string' && loopbackAddresses.has(addr);
}

export function runtimeEnvForRequest(env: Record<string, unknown> | undefined): Record<string, unknown> {
  return {
    ...process.env,
    ...(env ?? {}),
  };
}

export function readApiSecret(env: Record<string, unknown> | undefined): string | undefined {
  return readEnvString(runtimeEnvForRequest(env).API_SECRET);
}

function readEnvString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
