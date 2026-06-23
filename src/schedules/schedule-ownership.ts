/**
 * Shared ownership check for schedule tools (plan §2 auth boundary).
 *
 * Both the orchestrator `schedule_*` tools (ownerScope = chat actor id, derived
 * from the trusted eventId) and the coding-worker `coding_schedule_*` tools
 * (ownerScope = projectId, injected from the worker context) enforce that a
 * schedule belongs to the current owner before any read or mutation. This
 * prevents cross-actor / cross-project schedule access.
 */

import type { ScheduleStore } from './schedule-store.js';
import type { ScheduleRecord } from './schedule-types.js';

export type OwnedScheduleResult = { ok: true; record: ScheduleRecord } | { ok: false; error: string };

/**
 * Fetch a schedule by slug and enforce that it belongs to `ownerScope`.
 * Returns `{ok:false, error}` for not-found or scope mismatch so the tool can
 * return a JSON error without throwing.
 */
export function loadOwnedSchedule(
  store: ScheduleStore,
  slug: string,
  ownerScope: string,
): OwnedScheduleResult {
  const record = store.getBySlug(slug);
  if (!record) {
    return { ok: false, error: `schedule '${slug}' not found` };
  }
  if (record.ownerScope !== ownerScope) {
    return { ok: false, error: `schedule '${slug}' does not belong to this owner scope` };
  }
  return { ok: true, record };
}