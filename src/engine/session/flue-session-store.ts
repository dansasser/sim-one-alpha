import { createSessionStorageKey as createFlueRuntimeSessionStorageKey } from '@flue/runtime/adapter';

export interface FlueSessionStorageParts {
  instanceId: string;
  harnessName: string;
  sessionName: string;
}

const flueSessionStoragePrefix = 'agent-session:';

export function createFlueSessionStorageKey(
  instanceId: string,
  harnessName: string,
  sessionName: string,
): string {
  return createFlueRuntimeSessionStorageKey(instanceId, harnessName, sessionName);
}

export function parseFlueSessionStorageKey(id: string): FlueSessionStorageParts | undefined {
  if (!id.startsWith(flueSessionStoragePrefix)) {
    return undefined;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(id.slice(flueSessionStoragePrefix.length)) as unknown;
  } catch {
    return undefined;
  }

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
