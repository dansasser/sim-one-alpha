import type { MemoryRecordScope } from '../types/memory.js';

/**
 * Precedence (lower number = more specific):
 * 1. projectId + conversationId
 * 2. projectId
 * 3. conversationId
 * 4. actorId
 * 5. global
 */
export function precedence(scope: MemoryRecordScope): number {
  if (scope.projectId && scope.conversationId) return 1;
  if (scope.projectId) return 2;
  if (scope.conversationId) return 3;
  if (scope.actorId) return 4;
  return 5;
}

/**
 * Determine whether a record scope is visible to a query scope.
 * Mirrors the Rust `scope::matches` function.
 */
export function matchesScope(recordScope: MemoryRecordScope, queryScope: MemoryRecordScope): boolean {
  if (queryScope.global) {
    return !!recordScope.global;
  }

  if (queryScope.actorId && recordScope.actorId && queryScope.actorId !== recordScope.actorId) {
    return false;
  }
  if (
    queryScope.conversationId &&
    recordScope.conversationId &&
    queryScope.conversationId !== recordScope.conversationId
  ) {
    return false;
  }
  if (
    queryScope.projectId &&
    recordScope.projectId &&
    queryScope.projectId !== recordScope.projectId
  ) {
    return false;
  }
  if (
    queryScope.threadId &&
    recordScope.threadId &&
    queryScope.threadId !== recordScope.threadId
  ) {
    return false;
  }

  return precedence(recordScope) <= precedence(queryScope);
}
