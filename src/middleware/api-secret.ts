import type { MiddlewareHandler } from 'hono';

export const apiSecretHeaderName = 'x-api-secret';

export const requireApiSecret: MiddlewareHandler = async (c, next) => {
  const expectedSecret = readApiSecret(c.env as Record<string, unknown> | undefined);

  if (!expectedSecret) {
    return c.json({ error: 'API secret is not configured' }, 503);
  }

  if (c.req.header(apiSecretHeaderName) !== expectedSecret) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  await next();
};

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
