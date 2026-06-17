import { sqlite } from '@flue/runtime/node';
import type {
  AgentExecutionStore,
  PersistenceAdapter,
  PersistenceStores,
  SessionData,
  SessionStore,
} from '@flue/runtime/adapter';
import type { GoromboConfig } from '../config/gorombo-config.js';
import { createEmbeddingClient } from '../rag/embeddings.js';
import { runBackgroundIndexing } from '../rag/indexers/background-indexer.js';
import { LanceDbVectorStore } from '../rag/vector/index.js';
import {
  defaultSessionDatabasePath,
  GoromboSessionDatabase,
} from './session-database.js';
import { directAgentHarnessName, directAgentSessionName } from './direct-agent-session.js';
import {
  parseFlueSessionStorageKey,
  type FlueSessionStorageParts,
} from './flue-session-store.js';

export const defaultFlueDatabasePath = '.gorombo/db/flue.sqlite';

export interface GoromboPersistenceRuntime {
  adapter: PersistenceAdapter;
  sessionDatabase: GoromboSessionDatabase;
  vectorStore: LanceDbVectorStore;
  embeddingClient: ReturnType<typeof createEmbeddingClient>;
  getLatestSessionData(harnessName: string, sessionName: string): Promise<SessionData | null>;
  getLatestSessionDataForInstance(
    instanceId: string,
    harnessName: string,
    sessionName: string,
  ): Promise<SessionData | null>;
}

export function createGoromboPersistenceRuntime(config: GoromboConfig): GoromboPersistenceRuntime {
  const flueDatabasePath = config.storage?.flueDatabasePath ?? defaultFlueDatabasePath;
  const sessionDatabasePath = config.storage?.sessionDatabasePath ?? defaultSessionDatabasePath;
  const vectorStorePath = config.storage?.vectorStorePath;
  const flueAdapter = sqlite(flueDatabasePath);
  const vectorStore = new LanceDbVectorStore({ path: vectorStorePath });
  const embeddingClient = createEmbeddingClient();
  const sessionDatabase = new GoromboSessionDatabase(sessionDatabasePath, { vectorStore, embeddingClient });

  // Index project files and knowledge docs in the background so startup is not blocked.
  runBackgroundIndexing({ vectorStore, embeddingClient }).catch((error) =>
    console.error('[WARN] Background vector indexing failed:', error instanceof Error ? error.message : String(error)),
  );
  let latestStores: PersistenceStores | undefined;

  const adapter: PersistenceAdapter = {
    async migrate() {
      await flueAdapter.migrate?.();
      sessionDatabase.migrate();
    },
    async connect() {
      const stores = await flueAdapter.connect();
      const wrapped = {
        executionStore: {
          sessions: new GoromboLogicalSessionStore(stores.executionStore.sessions, sessionDatabase),
          submissions: stores.executionStore.submissions,
        },
        runStore: stores.runStore,
        eventStreamStore: stores.eventStreamStore,
      };
      latestStores = wrapped;
      return wrapped;
    },
    async close() {
      latestStores = undefined;
      await flueAdapter.close?.();
      sessionDatabase.close();
    },
  };

  async function getExecutionStore(): Promise<AgentExecutionStore> {
    const stores = latestStores ?? await adapter.connect();
    return stores.executionStore;
  }

  return {
    adapter,
    sessionDatabase,
    vectorStore,
    embeddingClient,
    async getLatestSessionData(harnessName, sessionName) {
      const storageKey = sessionDatabase.getLatestStorageKey(harnessName, sessionName);
      if (!storageKey) {
        return null;
      }

      return (await getExecutionStore()).sessions.load(storageKey);
    },
    async getLatestSessionDataForInstance(instanceId, harnessName, sessionName) {
      const storageKey = sessionDatabase.getLatestStorageKeyForInstance(instanceId, harnessName, sessionName);
      if (!storageKey) {
        return null;
      }

      return (await getExecutionStore()).sessions.load(storageKey);
    },
  };
}

class GoromboLogicalSessionStore implements SessionStore {
  constructor(
    private readonly flueSessions: SessionStore,
    private readonly sessionDatabase: GoromboSessionDatabase,
  ) {}

  async save(id: string, data: SessionData): Promise<void> {
    await this.flueSessions.save(id, data);
    this.sessionDatabase.enqueueSessionMemoryUpsert(id, () => this.sessionDatabase.recordFlueSession(id, data));
  }

  async load(id: string): Promise<SessionData | null> {
    const exact = await this.flueSessions.load(id);
    if (exact) {
      return exact;
    }

    const parts = parseFlueSessionStorageKey(id);
    if (!parts) {
      return null;
    }

    const latestInstanceStorageKey = this.sessionDatabase.getLatestStorageKeyForInstance(
      parts.instanceId,
      parts.harnessName,
      parts.sessionName,
    );
    if (latestInstanceStorageKey && latestInstanceStorageKey !== id) {
      return this.flueSessions.load(latestInstanceStorageKey);
    }

    if (isDirectAgentStorageKey(parts)) {
      return null;
    }

    const latestStorageKey = this.sessionDatabase.getLatestStorageKey(parts.harnessName, parts.sessionName);
    if (!latestStorageKey || latestStorageKey === id) {
      return null;
    }

    return this.flueSessions.load(latestStorageKey);
  }

  async delete(id: string): Promise<void> {
    const parts = parseFlueSessionStorageKey(id);
    if (!parts) {
      await this.flueSessions.delete(id);
      return;
    }

    const exact = await this.flueSessions.load(id);
    await this.flueSessions.delete(id);
    await this.sessionDatabase.deleteFlueSession(id);

    if (exact) {
      return;
    }

    const latestInstanceStorageKey = this.sessionDatabase.getLatestStorageKeyForInstance(
      parts.instanceId,
      parts.harnessName,
      parts.sessionName,
    );
    if (latestInstanceStorageKey && latestInstanceStorageKey !== id) {
      await this.flueSessions.delete(latestInstanceStorageKey);
      await this.sessionDatabase.deleteFlueSession(latestInstanceStorageKey);
      return;
    }

    if (isDirectAgentStorageKey(parts)) {
      return;
    }

    const latestStorageKey = this.sessionDatabase.getLatestStorageKey(parts.harnessName, parts.sessionName);
    if (latestStorageKey && latestStorageKey !== id) {
      await this.flueSessions.delete(latestStorageKey);
      await this.sessionDatabase.deleteFlueSession(latestStorageKey);
    }
  }
}

function isDirectAgentStorageKey(parts: FlueSessionStorageParts): boolean {
  return parts.harnessName === directAgentHarnessName && parts.sessionName === directAgentSessionName;
}
