import type { SessionData, SessionStore } from '@flue/runtime';

export interface FlueSessionStorageParts {
  instanceId: string;
  harnessName: string;
  sessionName: string;
}

const flueSessionStoragePrefix = 'agent-session:';

export class InMemoryFlueSessionStore implements SessionStore {
  private readonly sessionsByStorageKey = new Map<string, SessionData>();
  private readonly latestStorageKeyByLogicalSession = new Map<string, string>();

  async save(id: string, data: SessionData): Promise<void> {
    this.sessionsByStorageKey.set(id, cloneSessionData(data));

    const parts = parseFlueSessionStorageKey(id);
    if (parts) {
      this.latestStorageKeyByLogicalSession.set(logicalSessionKey(parts.harnessName, parts.sessionName), id);
    }
  }

  async load(id: string): Promise<SessionData | null> {
    const exact = this.sessionsByStorageKey.get(id);
    if (exact) {
      return cloneSessionData(exact);
    }

    const parts = parseFlueSessionStorageKey(id);
    if (!parts) {
      return null;
    }

    return this.getLatestSessionData(parts.harnessName, parts.sessionName);
  }

  async delete(id: string): Promise<void> {
    const parts = parseFlueSessionStorageKey(id);
    const exactDeleted = this.sessionsByStorageKey.delete(id);
    if (!parts) {
      return;
    }

    const logicalKey = logicalSessionKey(parts.harnessName, parts.sessionName);
    const latestStorageKey = this.latestStorageKeyByLogicalSession.get(logicalKey);
    if (!exactDeleted && latestStorageKey) {
      this.sessionsByStorageKey.delete(latestStorageKey);
    }

    if (latestStorageKey === id || !exactDeleted) {
      this.latestStorageKeyByLogicalSession.delete(logicalKey);
    }
  }

  getLatestSessionData(harnessName: string, sessionName: string): SessionData | null {
    const storageKey = this.latestStorageKeyByLogicalSession.get(logicalSessionKey(harnessName, sessionName));
    const data = storageKey ? this.sessionsByStorageKey.get(storageKey) : undefined;
    return data ? cloneSessionData(data) : null;
  }
}

export const goromboFlueSessionStore = new InMemoryFlueSessionStore();

export function createFlueSessionStorageKey(
  instanceId: string,
  harnessName: string,
  sessionName: string,
): string {
  return `${flueSessionStoragePrefix}${JSON.stringify([instanceId, harnessName, sessionName])}`;
}

export function parseFlueSessionStorageKey(id: string): FlueSessionStorageParts | undefined {
  if (!id.startsWith(flueSessionStoragePrefix)) {
    return undefined;
  }

  const raw = JSON.parse(id.slice(flueSessionStoragePrefix.length)) as unknown;
  if (!Array.isArray(raw) || raw.length !== 3 || !raw.every((value) => typeof value === 'string')) {
    return undefined;
  }

  const [instanceId, harnessName, sessionName] = raw;

  return {
    instanceId,
    harnessName,
    sessionName,
  };
}

function logicalSessionKey(harnessName: string, sessionName: string): string {
  return `${harnessName}\u0000${sessionName}`;
}

function cloneSessionData(data: SessionData): SessionData {
  return structuredClone(data);
}
