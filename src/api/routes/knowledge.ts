import { goromboPersistenceRuntime } from '../../core/db.js';
﻿import type { Hono } from 'hono';
import { normalizeWebApiMessage, type WebApiMessageInput } from '../../api/connectors/web-api.js';
import { requireApiSecret, runtimeEnvForRequest } from '../../api/middleware/api-secret.js';
import { runBackgroundIndexing } from '../../engine/rag/indexers/background-indexer.js';
import { LanceDbKnowledgeStore } from '../../engine/rag/knowledge-store.js';
import { addKnowledge } from '../../engine/memory/knowledge-service.js';
import { rememberKnowledgeEvent } from '../../engine/tools/knowledge-tool.js';

export function registerKnowledgeRoutes(app: Hono): void {
  app.post('/api/knowledge', requireApiSecret, async (c) => {
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON payload' }, 400);
    }

    const input = payload as {
      title?: unknown;
      content?: unknown;
      tags?: unknown;
      actorId?: unknown;
      conversationId?: unknown;
    };

    const title = readString(input.title);
    const content = readString(input.content);
    if (!title || !content) {
      return c.json({ error: 'title and content are required.' }, 400);
    }

    const runtimeEnv = runtimeEnvForRequest(c.env as Record<string, unknown> | undefined);
    const actorId = readString(input.actorId) ?? readString(runtimeEnv.GOROMBO_KNOWLEDGE_DEFAULT_ACTOR_ID) ?? 'api';
    const conversationId = readString(input.conversationId) ?? 'default';

    const event = normalizeWebApiMessage({
      text: `Knowledge added: ${title}`,
      actorId,
      conversationId,
    } as WebApiMessageInput);

    const tags = Array.isArray(input.tags)
      ? input.tags.filter((tag): tag is string => typeof tag === 'string')
      : undefined;

    const record = await addKnowledge({
      title,
      content,
      source: 'api',
      actorId,
      conversationId,
      tags,
      createdBy: actorId,
    });

    rememberKnowledgeEvent(event);

    return c.json({ record }, 201);
  });

  app.post('/api/knowledge/reindex', requireApiSecret, async (c) => {
    runBackgroundIndexing({
      vectorStore: goromboPersistenceRuntime.vectorStore,
      embeddingClient: goromboPersistenceRuntime.embeddingClient,
    }).catch((error) =>
      console.error('[WARN] Reindex failed:', error instanceof Error ? error.message : String(error)),
    );

    return c.json({ status: 'reindexing' }, 202);
  });
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
