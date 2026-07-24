import { resolve } from 'node:path';
import {
  createGithubAuthService,
  type CreateGithubAuthServiceOptions,
  type GithubAuthService,
} from './github-auth-service.js';

const services = new Map<string, Promise<GithubAuthService>>();

/**
 * Returns one auth runtime per managed root/workspace pair so a workflow and
 * worker tools observe the same retained device-login child and session state.
 */
export function getGithubAuthService(options: CreateGithubAuthServiceOptions): Promise<GithubAuthService> {
  const key = `${resolve(options.workspaceRoot)}\u0000${resolve(options.authRoot ?? '')}`;
  let service = services.get(key);
  if (!service) {
    const created = createGithubAuthService(options);
    service = created.catch((error) => {
      if (services.get(key) === service) {
        services.delete(key);
      }
      throw error;
    });
    services.set(key, service);
  }
  return service;
}

export function resetGithubAuthRuntimeForTest(): void {
  services.clear();
}
